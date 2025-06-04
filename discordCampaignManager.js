import { EmbedBuilder } from 'discord.js';
import { db } from './firebaseAdmin.js';

export async function updateActiveCampaigns(userId, discordClient) {
    try {
        // Get all servers for the user
        const serversSnapshot = await db
            .collection('servers')
            .where('owner_id', '==', userId)
            .get();

        const servers = serversSnapshot.docs.map(doc => ({
            id: doc.id,
            ...doc.data()
        }));

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
                campaign.serverIds?.includes(server.server_id)
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
                        .setTitle(campaign.name)
                        .setDescription(campaign.description || 'No description available')
                        .setColor(0x0099ff)
                        .addFields(
                            {
                                name: 'Status',
                                value: campaign.status || 'Active',
                                inline: true
                            },
                            {
                                name: 'Videos',
                                value: `${campaign.videos?.length || 0} submitted`,
                                inline: true
                            }
                        )
                        .setTimestamp()
                        .setFooter({ text: `Campaign ID: ${campaign.id}` });

                    if (campaign.imageUrl) {
                        embed.setImage(campaign.imageUrl);
                    }

                    await channel.send({ embeds: [embed] });
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