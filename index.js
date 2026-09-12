require('dotenv').config();
const {
    Client, GatewayIntentBits, Events, ActionRowBuilder, ButtonBuilder,
    ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle,
    REST, Routes, SlashCommandBuilder, EmbedBuilder, ChannelType, PermissionFlagsBits
} = require('discord.js');

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.GuildVoiceStates // нужен для системы временных голосовых каналов
    ]
});

// Константы
const GUILD_ID = '1531809360429191269';
const FROG_ROLE_ID = '1531838818066497547';
const THREAD_ID = '1540662786986606653';
const LOG_CHANNEL_ID = '1540668001882214411'; // технический канал (используется и старым, и новым функционалом)

// --- Константы новой системы ---
const WELCOME_CHANNEL_ID = '1531898560176717934'; // канал приветствий/прощаний
const RULES_CHANNEL_ID = '1531829916071366848';   // канал, на который ссылается приветствие
const TRIGGER_VOICE_ID = '1531834233327325258';   // войс-триггер для создания временных каналов
const TEMP_VC_CATEGORY_ID = '1531831070738350170'; // категория временных войсов

const WELCOME_IMAGE = 'https://i.imgur.com/OL1qJ81.png';
const FAREWELL_IMAGE = 'https://i.imgur.com/JRClktO.png';
const GREEN_COLOR = 0x57F287;

const commands = [
    new SlashCommandBuilder().setName('post-bot').setDescription('Опубликовать пост о боте')
];

// --- Состояние системы временных голосовых каналов (в памяти процесса) ---
// channelId -> { ownerId: string, order: string[] }  (order — порядок входа участников)
const tempVoiceChannels = new Map();
// userId -> true, пока для него выполняется создание канала (защита от дублирования событий)
const pendingCreation = new Set();

client.once(Events.ClientReady, async () => {
    const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
    await rest.put(Routes.applicationGuildCommands(client.user.id, GUILD_ID), { body: commands });

    try {
        const guild = await client.guilds.fetch(GUILD_ID);
        await recoverTempVoiceChannels(guild);
    } catch (err) {
        console.error('Не удалось восстановить состояние временных войсов после запуска:', err);
    }

    console.log(`Бот ${client.user.tag} запущен!`);
});

client.on(Events.InteractionCreate, async interaction => {
    // 1. Команда /post-bot
    if (interaction.isChatInputCommand() && interaction.commandName === 'post-bot') {
        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('start_rename').setLabel('Указать имя').setStyle(ButtonStyle.Success)
        );
        
        await interaction.channel.send({
            content: `<@&${FROG_ROLE_ID}>\n\n🐸 **Важное обновление Ранарии!**\nРанария активно расширяется, нас становится всё больше, и со временем становится трудно ориентироваться, кто есть кто.\nЧтобы всем было проще друг друга узнавать, мы подключили нашего дискорд-бота Квакшу! Теперь при входе на сервер он автоматически пишет новому участнику в ЛС и просит указать ник в Minecraft и РП-ник, после чего сам меняет ник на сервере в формате: Ник Майнкрафт ♮ РП ник.\n\n📌 **Что делать тем, кто уже на сервере?**\nРебята, которые уже давно с нами, пожалуйста, тоже укажите свои актуальные ники! Для этого достаточно просто нажать на зеленую кнопку «Указать имя» прямо под этим сообщением и заполнить небольшое окошко.\n\n💡 Если у вас есть любые идеи, пожелания или вы столкнулись с какими-то багами/проблемами в работе бота — смело пишите их в ветку <#${THREAD_ID}>.`,
            files: ['https://i.imgur.com/vEXMH98.jpeg'],
            components: [row]
        });
        await interaction.reply({ content: 'Пост успешно опубликован!', flags: 6 });
    }

    // 2. Кнопка "Указать имя"
    if (interaction.isButton() && interaction.customId === 'start_rename') {
        const modal = new ModalBuilder().setCustomId('rename_modal').setTitle('Укажи свои данные');
        modal.addComponents(
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('mc_nick').setLabel("Ник в Minecraft (Пример: LusyLusy)").setStyle(TextInputStyle.Short).setRequired(true)),
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('rp_nick').setLabel("РП ник (Пример: Айви)").setStyle(TextInputStyle.Short).setRequired(true))
        );
        await interaction.showModal(modal);
    }

    // 3. Обработка модального окна без лишних багов с вложениями
    if (interaction.isModalSubmit() && interaction.customId === 'rename_modal') {
        const mc = interaction.fields.getTextInputValue('mc_nick');
        const rp = interaction.fields.getTextInputValue('rp_nick');
        const newNickname = `${mc} ♮ ${rp}`;

        // Безопасный ответ Дискорду, чтобы модалка закрылась без ошибок и без отправки пустых сообщений
        await interaction.deferReply({ flags: 6 });

        const guild = await client.guilds.fetch(GUILD_ID);
        const logChannel = await guild.channels.fetch(LOG_CHANNEL_ID).catch(() => null);

        // Проверка длины
        if (newNickname.length > 32) {
            try {
                await interaction.user.send(`❌ Ошибка: Итоговый ник (**${newNickname}**) слишком длинный (${newNickname.length}/32). Лимит Дискорда — 32 символа. Попробуй сократить ники.`);
            } catch (e) {}
            await interaction.deleteReply().catch(() => {});
            return;
        }

        try {
            const member = await guild.members.fetch(interaction.user.id);
            const oldNickname = member.nickname || member.user.username;

            await member.setNickname(newNickname);
            
            // Успех -> В ЛС игроку
            try {
                await interaction.user.send(`✨ Готово! Твой ник на сервере **Ранария** успешно изменен на: **${newNickname}**`);
            } catch (e) {}

            // Отчет -> В тех-канал
            if (logChannel) {
                const embed = new EmbedBuilder()
                    .setColor(0x57F287)
                    .setTitle('✏️ Участник сменил ник')
                    .setDescription(`<@${interaction.user.id}> сменил(а) ник.`)
                    .addFields(
                        { name: 'Старый', value: oldNickname, inline: true },
                        { name: 'Новый', value: newNickname, inline: true }
                    )
                    .setTimestamp();
                await logChannel.send({ embeds: [embed] });
            }
        } catch (error) {
            // Ошибка -> В ЛС игроку
            try {
                await interaction.user.send('⚠️ Ошибка: я не могу изменить твой ник. Убедись, что роль бота стоит выше твоей роли в списке ролей сервера.');
            } catch (e) {}

            // Отчет об ошибке -> В тех-канал
            if (logChannel) {
                const errEmbed = new EmbedBuilder()
                    .setColor(0xED4245)
                    .setTitle('❌ Ошибка смены ника')
                    .setDescription(`Участник <@${interaction.user.id}> попытался сменить ник на **${newNickname}**, но возникла ошибка.`)
                    .setTimestamp();
                await logChannel.send({ embeds: [errEmbed] });
            }
        }

        // Очищаем скрытый ответ на взаимодействие
        await interaction.deleteReply().catch(() => {});
    }
});

client.on(Events.GuildMemberAdd, async member => {
    // ЛС-сообщение с кнопкой "Указать имя" — использует уже существующий обработчик start_rename
    try {
        const dmRow = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('start_rename').setLabel('Указать имя').setStyle(ButtonStyle.Success)
        );
        await member.send({
            content: 'Привет! Добро пожаловать в Ранарию! 🐸\nЧтобы установить свой Minecraft и РП ник, нажми кнопку **«Указать имя»** ниже.',
            components: [dmRow]
        });
    } catch (err) {}

    // --- Новое: выдача роли новому участнику ---
    try {
        await member.roles.add(FROG_ROLE_ID);
        await sendTechReport(member.guild, `🟢 Роль выдана\nПользователь: <@${member.id}>`);
    } catch (err) {
        console.error('Ошибка выдачи роли новому участнику:', err);
        await sendTechReport(member.guild, `❌ Не удалось выдать роль\nПользователь: <@${member.id}>\nПричина: ${err.message}`);
    }

    // --- Новое: приветственный Embed в канал приветствий/прощаний ---
    try {
        const welcomeChannel = await fetchChannelSafe(member.guild, WELCOME_CHANNEL_ID);
        if (welcomeChannel) {
            const embed = new EmbedBuilder()
                .setColor(GREEN_COLOR)
                .setDescription(
                    `🐸 Хэй, <@${member.id}>!\n\n` +
                    `Добро пожаловать на нашу территорию! 🚀 ✨\n\n` +
                    `Здесь всегда найдётся тёплый уголок для общения, уютных посиделок и классных идей. 💬\n\n` +
                    `Не бойся знакомиться с местными лягушатами, заглядывай в <#${RULES_CHANNEL_ID}> и вливайся в общий движ! 🌟\n\n` +
                    `Надеемся, что тебе у нас понравится.\n\n` +
                    `Приятного общения и отличного времени в нашем государстве!`
                )
                .setImage(WELCOME_IMAGE);
            await welcomeChannel.send({ embeds: [embed] });
        }
    } catch (err) {
        console.error('Ошибка отправки приветствия:', err);
        await sendTechReport(member.guild, `❌ Ошибка\nДействие: отправка приветствия\nПользователь: <@${member.id}>\nПричина: ${err.message}`);
    }
});

// --- Новое: прощание с участником ---
client.on(Events.GuildMemberRemove, async member => {
    try {
        const welcomeChannel = await fetchChannelSafe(member.guild, WELCOME_CHANNEL_ID);
        if (welcomeChannel) {
            const embed = new EmbedBuilder()
                .setColor(GREEN_COLOR)
                .setDescription(
                    `🐸 Тропа зарастает за уходящим путником, <@${member.id}>... 🧳 ✨\n\n` +
                    `Твои следы смывает болотным туманом, но время, проведённое за общими беседами и идеями, останется в истории нашей топи. 💬\n\n` +
                    `Лягушачье сообщество провожает тебя в путь — если заскучаешь по здешнему движу, наши двери всегда открыты. 🌟\n\n` +
                    `Пусть твои новые дороги будут ровными и интересными! 🍂`
                )
                .setImage(FAREWELL_IMAGE);
            await welcomeChannel.send({ embeds: [embed] });
        }
    } catch (err) {
        console.error('Ошибка отправки прощания:', err);
        await sendTechReport(member.guild, `❌ Ошибка\nДействие: отправка прощания\nПользователь: <@${member.id}>\nПричина: ${err.message}`);
    }
});

// --- Новое: система временных голосовых каналов ---
client.on(Events.VoiceStateUpdate, async (oldState, newState) => {
    const oldChannelId = oldState.channelId;
    const newChannelId = newState.channelId;

    if (oldChannelId === newChannelId) return; // мут/деф и т.п. — не интересует эту систему

    const member = newState.member || oldState.member;
    const guild = newState.guild || oldState.guild;
    if (!member || !guild) return;

    // 1) Обработка выхода из старого канала (если это временный канал системы)
    if (oldChannelId && tempVoiceChannels.has(oldChannelId)) {
        try {
            await handleLeaveTempChannel(guild, oldChannelId, member.id);
        } catch (err) {
            console.error('Ошибка обработки выхода из временного войса:', err);
            await sendTechReport(guild, `❌ Ошибка\nДействие: обработка выхода из временного войса\nПользователь: <@${member.id}>\nПричина: ${err.message}`);
        }
    }

    // 2) Обработка входа в новый канал
    if (newChannelId) {
        if (newChannelId === TRIGGER_VOICE_ID) {
            // Защита от дублирования: пока для пользователя идёт создание канала, повторные события игнорируются
            if (pendingCreation.has(member.id)) return;
            pendingCreation.add(member.id);
            try {
                const { channelName } = await createTempVoiceChannel(member);
                const time = new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
                await sendTechReport(guild, `🔊 Временный войс создан\nПользователь: <@${member.id}>\nКанал: ${channelName}\nВремя: ${time}`);
            } catch (err) {
                console.error('Ошибка создания временного войса:', err);
                await sendTechReport(guild, `❌ Не удалось создать временный войс\nПользователь: <@${member.id}>\nПричина: ${err.message}`);
            } finally {
                pendingCreation.delete(member.id);
            }
        } else if (tempVoiceChannels.has(newChannelId)) {
            // Пользователь зашёл в уже существующий временный канал — фиксируем порядок входа
            const state = tempVoiceChannels.get(newChannelId);
            if (!state.order.includes(member.id)) {
                state.order.push(member.id);
            }
        }
    }
});

// Достаёт канал из кэша или запрашивает у API, без выброса исключения
async function fetchChannelSafe(guild, channelId) {
    return guild.channels.cache.get(channelId) || await guild.channels.fetch(channelId).catch(() => null);
}

// Короткий технический отчёт в LOG_CHANNEL_ID
async function sendTechReport(guild, text) {
    try {
        const channel = await fetchChannelSafe(guild, LOG_CHANNEL_ID);
        if (channel) await channel.send(text);
    } catch (err) {
        console.error('Не удалось отправить технический отчёт:', err);
    }
}

// Собирает множество уже занятых номеров временных каналов внутри категории
function getUsedTempNumbers(category) {
    const used = new Set();
    const regex = /^🔊・(\d+)・/;
    category.children.cache.forEach(ch => {
        const match = ch.name.match(regex);
        if (match) used.add(parseInt(match[1], 10));
    });
    return used;
}

// Минимальный свободный номер, начиная с 1
function getMinFreeTempNumber(category) {
    const used = getUsedTempNumbers(category);
    let n = 1;
    while (used.has(n)) n++;
    return n;
}

// Собирает финальное имя канала, аккуратно обрезая при превышении лимита Discord (100 символов)
function buildTempChannelName(num, displayName) {
    const numStr = String(num).padStart(2, '0');
    const prefix = `🔊・${numStr}・`;
    const MAX_LEN = 100;

    const prefixLen = Array.from(prefix).length;
    const nameChars = Array.from(displayName);

    if (prefixLen + nameChars.length <= MAX_LEN) {
        return prefix + displayName;
    }

    const allowed = Math.max(MAX_LEN - prefixLen, 0);
    return prefix + nameChars.slice(0, allowed).join('');
}

// Создаёт временный голосовой канал для участника и перемещает его туда
async function createTempVoiceChannel(member) {
    const guild = member.guild;
    const category = await fetchChannelSafe(guild, TEMP_VC_CATEGORY_ID);
    if (!category) throw new Error('Категория для временных войсов не найдена');

    const num = getMinFreeTempNumber(category);
    const channelName = buildTempChannelName(num, member.displayName);

    const tempChannel = await guild.channels.create({
        name: channelName,
        type: ChannelType.GuildVoice,
        parent: category.id,
        permissionOverwrites: [
            {
                id: member.id,
                allow: [
                    PermissionFlagsBits.ManageChannels, // название, лимит участников, закрытие канала
                    PermissionFlagsBits.ManageRoles,    // индивидуальные разрешения/запреты для пользователей (только в этом канале)
                    PermissionFlagsBits.Connect,
                    PermissionFlagsBits.Speak
                ]
            }
        ]
    });

    tempVoiceChannels.set(tempChannel.id, { ownerId: member.id, order: [member.id] });

    try {
        await member.voice.setChannel(tempChannel);
    } catch (err) {
        // Перемещение не удалось (например, пользователь уже вышел) — канал остаётся, событие выхода удалит его при опустении
        console.error('Не удалось переместить пользователя во временный войс:', err);
    }

    return { tempChannel, num, channelName };
}

// Обрабатывает выход участника из временного канала: наследование владельца или удаление пустого канала
async function handleLeaveTempChannel(guild, channelId, userId) {
    const state = tempVoiceChannels.get(channelId);
    if (!state) return;

    state.order = state.order.filter(id => id !== userId);

    const channel = await fetchChannelSafe(guild, channelId);
    if (!channel) {
        tempVoiceChannels.delete(channelId);
        return;
    }

    if (channel.members.size === 0) {
        tempVoiceChannels.delete(channelId);
        try {
            await channel.delete();
        } catch (err) {
            console.error('Ошибка удаления пустого временного войса:', err);
            await sendTechReport(guild, `❌ Не удалось удалить временный войс\nКанал: #${channel.name}\nПричина: ${err.message}`);
        }
        return;
    }

    if (state.ownerId === userId) {
        const newOwnerId = state.order[0];
        if (newOwnerId) {
            await transferOwnership(channel, state, newOwnerId);
        }
    }
}

// Передаёт права владельца следующему пользователю в очереди и уведомляет об этом прямо в войсе
async function transferOwnership(channel, state, newOwnerId) {
    const oldOwnerId = state.ownerId;
    state.ownerId = newOwnerId;

    try {
        if (oldOwnerId) {
            await channel.permissionOverwrites.delete(oldOwnerId).catch(() => {});
        }
        await channel.permissionOverwrites.edit(newOwnerId, {
            ManageChannels: true,
            ManageRoles: true,
            Connect: true,
            Speak: true
        });
    } catch (err) {
        console.error('Ошибка обновления прав нового владельца войса:', err);
        await sendTechReport(channel.guild, `❌ Ошибка\nДействие: обновление прав нового владельца войса\nКанал: #${channel.name}\nПричина: ${err.message}`);
    }

    try {
        await channel.send(`👑 Владелец войса покинул его.\nНовый владелец: <@${newOwnerId}>`);
    } catch (err) {
        console.error('Не удалось отправить сообщение о смене владельца в войс:', err);
        await sendTechReport(channel.guild, `❌ Ошибка\nДействие: отправка сообщения о смене владельца\nКанал: #${channel.name}\nПричина: ${err.message}`);
    }
}

// Восстанавливает состояние временных войсов после перезапуска бота (best-effort, без базы данных)
async function recoverTempVoiceChannels(guild) {
    const category = await fetchChannelSafe(guild, TEMP_VC_CATEGORY_ID);
    if (!category) return;

    const regex = /^🔊・(\d+)・/;
    const children = Array.from(category.children.cache.values());

    for (const ch of children) {
        if (ch.type !== ChannelType.GuildVoice) continue;
        if (!regex.test(ch.name)) continue;

        if (ch.members.size === 0) {
            // Пустой временный канал, оставшийся с прошлого запуска — можно безопасно удалить
            try {
                await ch.delete();
            } catch (err) {
                console.error('Ошибка удаления осиротевшего временного войса после рестарта:', err);
            }
            continue;
        }

        // Порядок входа восстановить точно нельзя без базы данных — берём текущий состав канала.
        // Владельцем становится первый пользователь в этом (best-effort) списке.
        const members = Array.from(ch.members.keys());
        tempVoiceChannels.set(ch.id, { ownerId: members[0], order: members });
    }
}

const crypto = require('crypto');

const token = process.env.DISCORD_TOKEN;

console.log('========== TOKEN CHECK ==========');
console.log('exists:', !!token);
console.log('length:', token ? token.length : null);
console.log(
    'hash:',
    token
        ? crypto.createHash('sha256').update(token).digest('hex')
        : null
);
console.log('=================================');

client.login(token);