
import 'dotenv/config';
import { Client, GatewayIntentBits } from 'discord.js';
import { db } from './firebaseAdmin.js';

const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent]
});

const baseUrl = process.env.BOT_LOGIN_REDIRECT_URL || 'http://localhost:3000/auth/signin/link';

client.once('ready', () => {
    console.log(`Bot is online as ${client.user.tag}`);
});

client.on('messageCreate', async (message) => {
    if (message.author.bot) return;

    const discordId = message.author.id;

    if (message.content === '!login') {
        const link = `${baseUrl}?discordId=${discordId}`;
        return message.reply(`Log in here: ${link}`);
    }

    if (message.content.startsWith('!submit ')) {
        const url = message.content.replace('!submit ', '').trim();

        if (!url.startsWith('http')) {
            return message.reply('Invalid URL');
        }

        const userRef = db.collection('discordUsers').doc(discordId);
        const doc = await userRef.get();

        if (!doc.exists) {
            return message.reply('Please login first using !login');
        }

        const current = doc.data().urls || [];
        await userRef.update({ urls: [...current, url] });

        return message.reply('URL submitted!');
    }
});

client.login(process.env.DISCORD_BOT_TOKEN);
