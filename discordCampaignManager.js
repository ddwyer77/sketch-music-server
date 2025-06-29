import { EmbedBuilder } from 'discord.js';
import { db } from './firebaseAdmin.js';

export async function updateActiveCampaigns(discordClient) {
    try {

        const serversSnapshot = await db
            .collection('servers')
            .get();

        let servers = serversSnapshot.docs.map(doc => ({
            id: doc.id,
            ...doc.data()
        }));

        if (process.env.ENVIRONMENT === "development") {
            servers = servers.filter(server => !server.isProductionServer);
        } else if (process.env.ENVIRONMENT === 'production') {
            servers = servers.filter(server => server.isProductionServer);
        }

        // Get all campaigns
        const campaignsSnapshot = await db
            .collection('campaigns')
            .get();

        const campaigns = campaignsSnapshot.docs.map(doc => ({
            id: doc.id,
            ...doc.data()
        }));

        const results = [];

        // For each server
        for (const server of servers) {
            // Find campaigns that include this server's ID
            const relevantCampaigns = campaigns.filter(campaign => 
                campaign.serverIds?.includes(server.server_id) && !campaign.isComplete
            );

            // Get the Discord channel
            const channel = await discordClient.channels.fetch(server.active_campaigns_channel_id);
            if (!channel) {
                results.push({
                    serverId: server.server_id,
                    status: 'failed',
                    error: 'Channel not found'
                });
                continue;
            }

            try {
                // Clear existing messages in the channel
                await channel.bulkDelete(100).catch(console.error);

                // Send new campaign embeds
                for (const campaign of relevantCampaigns) {
                    const embed = new EmbedBuilder()
                        .setTitle(campaign.name || 'N/A')
                        .setColor(0x0099ff);

                    // Row 1: Type, Views, Earnings (3 inline fields)
                    embed.addFields(
                        {
                            name: '📝 Type',
                            value: campaign.type || 'N/A',
                            inline: true
                        },
                        {
                            name: '👀 Views',
                            value: campaign.views?.toLocaleString() || 'N/A',
                            inline: true
                        },
                        {
                            name: '💰 Earnings',
                            value: campaign.budgetUsed && campaign.budget 
                                ? `$${campaign.budgetUsed.toLocaleString()} / $${campaign.budget.toLocaleString()}`
                                : 'N/A',
                            inline: true
                        }
                    );

                    // Row 2: Rate, Max Submissions, Sounds (3 inline fields)
                    embed.addFields(
                        {
                            name: '💵 Rate',
                            value: campaign.ratePerMillion 
                                ? `$${campaign.ratePerMillion.toLocaleString()}/M views`
                                : 'N/A',
                            inline: true
                        },
                        {
                            name: '📊 Max Submissions',
                            value: campaign.maxSubmissions?.toLocaleString() || 'N/A',
                            inline: true
                        },
                        {
                            name: '🎵 Sounds',
                            value: campaign.soundUrl 
                                ? `[Listen](${campaign.soundUrl})`
                                : 'N/A',
                            inline: true
                        }
                    );

                    // Full-width fields: Completion and Notes
                    if (campaign.budgetUsed && campaign.budget) {
                        const completionPercentage = (campaign.budgetUsed / campaign.budget) * 100;
                        const progressBar = createProgressBar(completionPercentage);
                        embed.addFields({
                            name: '📈 Completion',
                            value: `${progressBar} ${completionPercentage.toFixed(1)}%`,
                            inline: false
                        });
                    } else {
                        embed.addFields({
                            name: '📈 Completion',
                            value: 'N/A',
                            inline: false
                        });
                    }

                    // Notes at the bottom (full width)
                    if (campaign.notes && campaign.notes.trim() !== '') {
                        const truncatedNotes = campaign.notes.length > 200 ? 
                            campaign.notes.substring(0, 197) + '...' : campaign.notes;
                        embed.addFields({
                            name: '📋 Notes',
                            value: truncatedNotes,
                            inline: false
                        });
                    }

                    if (campaign.imageUrl) {
                        embed.setThumbnail(campaign.imageUrl);
                    }

                    await channel.send({ 
                        embeds: [embed],
                        flags: 4096 // This is the suppressNotifications flag
                    });
                }

                results.push({
                    serverId: server.server_id,
                    status: 'success'
                });
            } catch (error) {
                console.error(`Error updating campaigns for server ${server.server_id}:`, error);
                results.push({
                    serverId: server.server_id,
                    status: 'failed',
                    error: error.message
                });
            }
        }

        return {
            success: true,
            results
        };
    } catch (error) {
        console.error('Error updating active campaigns:', error);
        throw error;
    }
}

function createProgressBar(percentage) {
    const filledBlocks = Math.floor(percentage / 10);
    const emptyBlocks = 10 - filledBlocks;
    return `[${'█'.repeat(filledBlocks)}${'░'.repeat(emptyBlocks)}]`;
} 
