import { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder, MessageFlags, EmbedBuilder } from 'discord.js';
import 'dotenv/config';
import { isUserAuthenticated, getFirebaseUserId, sanitizeDiscordId,sanitizeUrl,sanitizeCampaignId,videoContainsRequiredSound,getTikTokVideoData,linkTikTokAccount } from './helper.js';
import crypto from 'crypto';
import { db, FieldValue } from './firebaseAdmin.js';
import { TOKEN_EXPIRY, RATE_LIMIT_WINDOW, MAX_REQUESTS, RATE_LIMIT } from './constants.js';

const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent]
});

const baseUrl = process.env.BOT_LOGIN_REDIRECT_URL;

// Rate limiting function
const isRateLimited = (userId) => {
    const now = Date.now();
    const userRequests = RATE_LIMIT.get(userId) || [];
    
    // Clean old requests
    const recentRequests = userRequests.filter(time => now - time < RATE_LIMIT_WINDOW);
    
    if (recentRequests.length >= MAX_REQUESTS) {
        return true;
    }
    
    recentRequests.push(now);
    RATE_LIMIT.set(userId, recentRequests);
    return false;
};

// Command definitions
const commandsList = [
    new SlashCommandBuilder()
        .setName('submit')
        .setDescription('Submit a video to a campaign')
        .addStringOption(option =>
             option
                  .setName('campaign_id')
                  .setDescription('The campaign ID')
                  .setRequired(true)
                  .setAutocomplete(true)
              )
        .addStringOption(option =>
            option.setName('video_url')
                .setDescription('The URL of the video to add')
                .setRequired(true)),
    new SlashCommandBuilder()
        .setName('login')
        .setDescription('Get a link to authenticate your Discord account'),
    new SlashCommandBuilder()
        .setName('logout')
        .setDescription('Unlink your Discord account'),
    new SlashCommandBuilder()
        .setName('status')
        .setDescription('Check if you are logged in'),
    new SlashCommandBuilder()
        .setName('campaigns')
        .setDescription('List current campaigns assigned to your server.'),
    new SlashCommandBuilder()
        .setName('commands')
        .setDescription('List available commands'),
    new SlashCommandBuilder()
        .setName('link')
        .setDescription('Link your TikTok account')
        .addStringOption(option =>
            option.setName('tiktok_username')
                .setDescription('Your TikTok username')
                .setRequired(true))
        .addStringOption(option =>
            option.setName('link_token')
                .setDescription('The token generated from the website')
                .setRequired(true)),
];

// Command handlers
const handleSubmitCommand = async (interaction) => {
    try {
        // Defer the reply immediately since this command has multiple async operations
        await interaction.deferReply({ ephemeral: true });

        // Check if user is authenticated
        const isAuthenticated = await isUserAuthenticated(interaction.user.id);
        if (!isAuthenticated) {
            return interaction.editReply({ 
                content: 'You need to authenticate first. Use the /login command.'
            });
        }

        const firebaseUserId = await getFirebaseUserId(interaction.user.id);
        if (!firebaseUserId) {
            return interaction.editReply({ 
                content: 'You need to link your Discord account first. Use the /login command.'
            });
        }

        // Check if TikTok account is verified
        const userDoc = await db.collection('users').doc(firebaseUserId).get();
        const userData = userDoc.data();
        
        if (!userData?.tiktokVerified) {
            const errorEmbed = new EmbedBuilder()
                .setColor('#FF0000')
                .setTitle('❌ TikTok Account Not Verified')
                .setDescription('You need to verify your TikTok account before submitting videos. Use the /link command to verify your TikTok account.');
            
            return interaction.editReply({
                embeds: [errorEmbed]
            });
        }

        const campaignId = sanitizeCampaignId(interaction.options.getString('campaign_id'));
        const videoUrl = sanitizeUrl(interaction.options.getString('video_url'));

        const campaignRef = db.collection('campaigns').doc(campaignId);
        const campaign = await campaignRef.get();
        const campaignData = campaign.data();

        if (!campaign.exists) {
            return interaction.editReply({ 
                content: 'Campaign not found.'
            });
        }

        // Check if campaign is complete
        if (campaignData.isComplete) {
            return interaction.editReply({ 
                content: 'Sorry, this campaign has already ended.'
            });
        }

        // Get TikTok video data
        const videoData = await getTikTokVideoData(videoUrl);

        // Check if required sound is included
        if (campaignData.requireSound && campaignData.soundId) {
            const hasRequiredSound = await videoContainsRequiredSound(videoUrl, campaignData);
            if (!hasRequiredSound) {
                const errorEmbed = new EmbedBuilder()
                    .setColor('#FF0000')
                    .setTitle('❌ Error')
                    .setDescription(`We've detected this submission does not contain the required sound ID: ${campaignData.soundId}. Please double check your submission or contact your administrator for more information.`);
                
                return interaction.editReply({ 
                    embeds: [errorEmbed]
                });
            }
        }

        // Check for duplicate submissions
        const existingVideos = campaignData.videos || [];
        const isDuplicate = existingVideos.some(video => video.url === videoUrl);
        
        if (isDuplicate) {
            const errorEmbed = new EmbedBuilder()
                .setColor('#FF0000')
                .setTitle('❌ Error')
                .setDescription('This video has already been submitted.');
            
            return interaction.editReply({
                embeds: [errorEmbed]
            });
        }

        // Check max submissions limit
        if (campaignData.maxSubmissions && campaignData.maxSubmissions !== '' && campaignData.maxSubmissions !== null) {
            const currentSubmissions = existingVideos.length;
            if (currentSubmissions >= campaignData.maxSubmissions) {
                const errorEmbed = new EmbedBuilder()
                    .setColor('#FF0000')
                    .setTitle('❌ Error')
                    .setDescription('Sorry, this campaign has already reached the max number of submissions');
                
                return interaction.editReply({
                    embeds: [errorEmbed]
                });
            }
        }

        const now = Date.now();
        const submissionData = {
            author_id: firebaseUserId,
            created_at: now,
            status: 'pending',
            updated_at: now,
            url: videoUrl,
            // Add TikTok video data
            id: videoData.id,
            title: videoData.title,
            author: videoData.author,
            views: videoData.views,
            shares: videoData.shares,
            comments: videoData.comments,
            likes: videoData.likes,
            description: videoData.description,
            createdAt: videoData.createdAt,
            musicTitle: videoData.musicTitle,
            musicAuthor: videoData.musicAuthor,
            musicId: videoData.musicId,
            hasBeenPaid: false
        };

        await campaignRef.update({
            videos: FieldValue.arrayUnion(submissionData)
        });

        const successEmbed = new EmbedBuilder()
            .setColor('#00FF00')
            .setTitle('✅ Success')
            .setDescription('Video added successfully!');

        return interaction.editReply({ 
            embeds: [successEmbed]
        });
    } catch (error) {
        console.error('Error adding video:', error);
        let errorMessage = 'There was an error adding your video. ';
        
        if (error.message.includes('Invalid')) {
            errorMessage += error.message;
        } else if (error.message.includes('Could not extract video ID')) {
            if (error.message.includes('/photo/')) {
                errorMessage = '❌ Error: You have submitted a TikTok photo instead of a video. Please submit a video URL instead.';
            } else {
                errorMessage = '❌ Error: Invalid TikTok URL. Please make sure you are submitting a valid TikTok video URL.';
            }
        } else {
            errorMessage += 'Please try again.';
        }

        const errorEmbed = new EmbedBuilder()
            .setColor('#FF0000')
            .setTitle('❌ Error')
            .setDescription(errorMessage);
        
        if (interaction.deferred) {
            return interaction.editReply({ 
                embeds: [errorEmbed]
            });
        } else {
            return interaction.reply({ 
                embeds: [errorEmbed],
                flags: MessageFlags.Ephemeral
            });
        }
    }
};

const handleCampaignsCommand = async (interaction) => {
    const isAuthenticated = await isUserAuthenticated(interaction.user.id);
    if (!isAuthenticated) {
        return interaction.reply({
            content: 'Please log in to view campaigns with the /login command.',
            flags: MessageFlags.Ephemeral
        });
    }

    const serverId = interaction.guildId;
    const campaignsSnapshot = await db
        .collection('campaigns')
        .where('serverIds', 'array-contains', serverId)
        .where('isComplete', '==', false)
        .limit(10)
        .get();

    if (campaignsSnapshot.empty) {
        return interaction.reply({
            content: 'No active campaigns found for this server. Please contact the server admin for more information.',
            flags: MessageFlags.Ephemeral
        });
    }
    
    const embeds = campaignsSnapshot.docs.map(doc => {
        const data = doc.data();
        const embed = new EmbedBuilder()
            .setTitle(data.name || 'Untitled Campaign')
            .setDescription(`**Campaign ID:** \`${doc.id}\``)
            .setImage(data.imageUrl);

        let soundSection = '';
        if (data.soundId && data.soundId.trim() !== '') {
            soundSection += `**ID:** \`${data.soundId}\`\n`;
        } else {
            soundSection += `**ID:** N/A\n`;
        }
        if (data.soundUrl && data.soundUrl.trim() !== '') {
            soundSection += `**URL:** [Listen here](${data.soundUrl})`;
        } else {
            soundSection += `**URL:** N/A`;
        }
        embed.addFields({ name: "Sound", value: soundSection });

        let notesSection = '';
        if (data.notes && data.notes.trim() !== '') {
            notesSection = data.notes;
        } else {
            notesSection = "N/A";
        }

        embed.addFields({ name: "Notes", value: notesSection });

        return embed;
    });

    const seeAllNote = `Don't see what you're looking for? To see all campaigns, [click here](${process.env.FRONTEND_BASE_URL}/campaigns?serverId=${serverId}).`;

    return interaction.reply({
        content: seeAllNote,
        embeds,
        flags: MessageFlags.Ephemeral 
    });
};

const handleLoginCommand = async (interaction) => {
    try {
        // Generate token and create document
        const token = crypto.randomBytes(32).toString('hex');
        const expiresAt = Date.now() + TOKEN_EXPIRY;

        // Create the token document
        await db.collection('discord_login_tokens').doc(token).set({
            discord_id: sanitizeDiscordId(interaction.user.id),
            username: interaction.user.username,
            expires_at: expiresAt,
            used: false,
            created_at: Date.now()
        });

        // Generate the login URL with the token
        const link = `${baseUrl}?token=${token}`;
        return interaction.reply({ 
            content: `Click this link to link your Discord account: ${link}`,
            flags: MessageFlags.Ephemeral 
        });
    } catch (error) {
        console.error('Error generating login link:', error);
        return interaction.reply({ 
            content: 'Sorry, there was an error generating your login link. Please try again.',
            flags: MessageFlags.Ephemeral 
        });
    }
};

const handleLogoutCommand = async (interaction) => {
    try {
        const isAuthenticated = await isUserAuthenticated(interaction.user.id);
        if (!isAuthenticated) {
            return interaction.reply({
                content: 'It looks like you are already logged out. Log in with /login.',
                flags: MessageFlags.Ephemeral 
            });
        }

        // Find the user document with this Discord ID
        const userQuery = await db.collection('users')
            .where('discord_id', '==', sanitizeDiscordId(interaction.user.id))
            .limit(1)
            .get();

        if (!userQuery.empty) {
            // Remove the Discord ID from the user document
            await userQuery.docs[0].ref.update({
                discord_id: FieldValue.delete()
            });
        }

        await interaction.reply({ content: 'You have been logged out.', flags: MessageFlags.Ephemeral});
    } catch (error) {
        console.error('Error logging out:', error);
        return interaction.reply({ 
            content: 'Sorry, an error has occurred attempting to log you out. Please try again later.',
            flags: MessageFlags.Ephemeral 
        });
    }
};

const handleStatusCommand = async (interaction) => {
    try {
        const isAuthenticated = await isUserAuthenticated(interaction.user.id);
        let email = null;
        let tiktokVerified = false;
        const firebaseUserId = await getFirebaseUserId(interaction.user.id);
        if (firebaseUserId) {
            const userDoc = await db.collection('users').doc(firebaseUserId).get();
            if (userDoc.exists) {
                email = userDoc.data().email || null;
                tiktokVerified = userDoc.data().tiktokVerified || false;
            }
        }
        let content = `**Username:** \`${interaction.user.username}\`\n**Logged In:** \`${isAuthenticated}\`\n**Server ID:** \`${interaction.guildId}\`\n**TikTok Account Verified:** \`${tiktokVerified}\``;
        if (email) {
            content += `\n**Email:** \`${email}\``;
        }
        return interaction.reply({
            content,
            flags: MessageFlags.Ephemeral
        });
    } catch (error) {
        console.error('An error has occurred with the status command:', error);
        return interaction.reply({ 
            content: 'Sorry, an error has occurred while trying to retrieve your status. Please try again later.',
            flags: MessageFlags.Ephemeral 
        });
    }
};

const handleCommandsCommand = async (interaction) => {
    const embed = new EmbedBuilder()
        .setTitle('Available Commands')
        .setDescription('List of available bot commands and their usage.');

    for (const cmd of commandsList) {
        // Turn SlashCommandBuilder into a JSON object for easy inspection
        const { name, description, options } = cmd.toJSON();

        let argString = '';
        if (options && options.length > 0) {
            argString = options.map(opt =>
                `• \`${opt.name}\`${opt.required ? ' (required)' : ''}: ${opt.description}`
            ).join('\n');
        }

        embed.addFields({
            name: `/${name}`,
            value: `${description}${argString ? '\n' + argString : ''}`
        });
    }

    return interaction.reply({
        embeds: [embed],
        flags: MessageFlags.Ephemeral
    });
};

const handleLinkCommand = async (interaction) => {
    try {
        // Check if user is authenticated
        const isAuthenticated = await isUserAuthenticated(interaction.user.id);
        if (!isAuthenticated) {
            return interaction.reply({ 
                content: 'You need to authenticate first. Use the /login command.', 
                flags: MessageFlags.Ephemeral
            });
        }

        const firebaseUserId = await getFirebaseUserId(interaction.user.id);
        if (!firebaseUserId) {
            return interaction.reply({ 
                content: 'You need to link your Discord account first. Use the /login command.', 
                flags: MessageFlags.Ephemeral
            });
        }

        const tiktokUsername = interaction.options.getString('tiktok_username');
        const linkToken = interaction.options.getString('link_token');

        if (!tiktokUsername || !linkToken) {
            const errorEmbed = new EmbedBuilder()
                .setColor('#FF0000')
                .setTitle('❌ Error')
                .setDescription('Both TikTok username and link token are required.');
            
            return interaction.reply({
                embeds: [errorEmbed],
                flags: MessageFlags.Ephemeral
            });
        }
        
        // First reply to acknowledge the command
        await interaction.deferReply({ ephemeral: true });

        // Link the TikTok account
        const result = await linkTikTokAccount(tiktokUsername, linkToken);
        
        const embed = new EmbedBuilder()
            .setTitle(result.success ? '✅ Success' : '❌ Error')
            .setDescription(result.message)
            .setColor(result.success ? '#00FF00' : '#FF0000');

        if (result.success) {
            embed.addFields(
                { name: 'TikTok Username', value: result.data.uniqueId },
                { name: 'Profile', value: result.data.title }
            );
        }

        return interaction.editReply({
            embeds: [embed],
            flags: MessageFlags.Ephemeral
        });

    } catch (error) {
        console.error('Error in link command:', error);
        const errorEmbed = new EmbedBuilder()
            .setColor('#FF0000')
            .setTitle('❌ Error')
            .setDescription('Failed to link TikTok account. Please try again later.');
        
        return interaction.editReply({
            embeds: [errorEmbed],
            flags: MessageFlags.Ephemeral
        });
    }
};

const handleCampaignAutocomplete = async (interaction) => {
    try {
        const serverId = interaction.guildId;
        const query = interaction.options.getFocused(true).value?.toLowerCase() || '';

        // Fetch up to 25 campaigns for this server that are not complete
        const campaignsSnapshot = await db
            .collection('campaigns')
            .where('serverIds', 'array-contains', serverId)
            .where('isComplete', '==', false)
            .limit(25)
            .get();

        const MAX_NAME_LENGTH = 100;

        const choices = campaignsSnapshot.docs
            .map(doc => {
                const data = doc.data();
                // Combine name and notes, truncate to 100 chars if needed
                let name = `${data.name || doc.id}`;
                if (name.length > MAX_NAME_LENGTH) {
                    name = name.slice(0, MAX_NAME_LENGTH - 1) + '…';
                }
                return {
                    name,
                    value: doc.id
                };
            })
            // Filter by user's current input
            .filter(choice => choice.name.toLowerCase().includes(query))
            .slice(0, 25);

        // If no campaigns are available, show a message
        if (choices.length === 0) {
            return interaction.respond([
                { name: 'Sorry, there are currently no active campaigns', value: 'no_campaigns' }
            ]);
        }

        // Always respond (even with an empty array)
        return interaction.respond(choices);
    } catch (error) {
        console.error('Autocomplete error:', error);
        // Show a fallback if error occurs
        return interaction.respond([
            { name: 'Failed to load campaigns', value: 'error' }
        ]);
    }
};

// Export everything
export {
    client,
    commandsList,
    isRateLimited,
    handleSubmitCommand,
    handleCampaignsCommand,
    handleLoginCommand,
    handleLogoutCommand,
    handleStatusCommand,
    handleCommandsCommand,
    handleLinkCommand,
    handleCampaignAutocomplete
};

export const loginClient = () => {
    return new Promise((resolve, reject) => {
        client.login(process.env.DISCORD_BOT_TOKEN)
            .then(() => {
                console.log('Discord bot logged in successfully');
                resolve();
            })
            .catch((error) => {
                console.error('Failed to login Discord bot:', error);
                reject(error);
            });
    });
};
