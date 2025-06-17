import { calculateEarnings, updateCampaignMetrics } from './helper.js';
import { db, FieldValue } from './firebaseAdmin.js';
import axios from 'axios';

const PAYPAL_CLIENT_ID = process.env.PAYPAL_CLIENT_ID;
const PAYPAL_SECRET_KEY = process.env.PAYPAL_SECRET_KEY;
const PAYPAL_API_BASE = process.env.PAYPAL_MODE 

// 1. Get PayPal OAuth token
async function getPayPalAccessToken() {
    const response = await axios({
        url: `${PAYPAL_API_BASE}/v1/oauth2/token`,
        method: 'post',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        auth: {
        username: PAYPAL_CLIENT_ID,
        password: PAYPAL_SECRET_KEY,
        },
        data: 'grant_type=client_credentials',
    });
    return response.data.access_token;
}

// 2. Send payout batch
async function sendPayoutBatch(recipients) {
    const accessToken = await getPayPalAccessToken();
    const payoutItems = recipients.map(user => ({
        recipient_type: 'EMAIL',
        amount: {
        value: user.payoutAmount,
        currency: 'USD',
        },
        receiver: user.paymentEmail,
        note: 'Creator payout',
        sender_item_id: user.id,
    }));

    const body = {
        sender_batch_header: {
        sender_batch_id: `batch_${Date.now()}`,
        email_subject: 'You have a payout!',
        },
        items: payoutItems,
    };

    const response = await axios({
        url: `${PAYPAL_API_BASE}/v1/payments/payouts`,
        method: 'post',
        headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`,
        },
        data: body,
    });

    return response.data;
}

export async function calculatePendingCampaignPayments(campaign) {
    try {
        // Metrics for campaign is updated before submitting request on front end
        let userPayoutData = {};
        const videos = campaign.videos || [];
        let unpaidVideos = [];

        videos.forEach(video => {
            const earningsForThisVideo = video.earnings;
            const authorId = video.author_id;

            // Check for conditions that would prevent payment
            if (video.status !== "approved") {
                unpaidVideos.push({
                    payeeId: authorId,
                    reasonNoPaymentSent: "Status was not 'approved'",
                    video
                });
            } else if (video.hasBeenPaid === true) {
                unpaidVideos.push({
                    payeeId: authorId,
                    reasonNoPaymentSent: "Video has already been marked as paid",
                    video
                });
            } else if (video.earnings <= 0) {
                unpaidVideos.push({
                    payeeId: authorId,
                    reasonNoPaymentSent: "The video has earned $0.00",
                    video
                });
            } else {
                // Only process payment for videos that pass all checks
                if (userPayoutData[authorId]) {
                    userPayoutData[authorId].amountOwed += earningsForThisVideo;
                    userPayoutData[authorId].videos.push(video);
                } else {
                    userPayoutData[authorId] = {
                        payeeId: authorId,
                        amountOwed: earningsForThisVideo,
                        videos: [video]
                    };
                }
            }
        });

        // Add user doc data to each payout entry
        const userIds = Object.keys(userPayoutData);
        const userSnapshots = await Promise.all(
            userIds.map(id => db.collection('users').doc(id).get())
        );

        userSnapshots.forEach(snapshot => {
            if (snapshot.exists) {
                const userData = snapshot.data();
                const userId = snapshot.id;
                userPayoutData[userId] = {
                    ...userPayoutData[userId],
                    ...userData
                };
            }
        });
        
        const userPayoutArray = Object.values(userPayoutData);
        return {
            pendingPayments: userPayoutArray,
            unpaidVideos: unpaidVideos
        };

    } catch (error) {
        console.error('Error calculating pending campaign payments:', error);
        throw new Error('Failed to calculate pending payments: ' + error.message);
    }
}

export async function payCreator(payments, campaign, { actorId, actorName }) {
    try {
        let hasErrors = false;
        const pendingPayments = payments.pendingPayments;
        const campaignId = campaign.id;
        
        // Process each user's payment
        for (const payment of pendingPayments) {
            try {
                // Skip if no amount to pay
                if (payment.amountOwed <= 0) {
                    console.log(`Skipping payment for ${payment.payeeId} - amount is 0`);
                    continue;
                }

                // Prepare PayPal payout
                const payoutData = {
                    paymentEmail: payment.paymentEmail,
                    payoutAmount: payment.amountOwed.toFixed(2),
                    id: payment.payeeId
                };

                // Send PayPal payout
                const payoutResult = await sendPayoutBatch([payoutData]);

                // Verify PayPal response
                if (!payoutResult || !payoutResult.batch_header || !payoutResult.batch_header.payout_batch_id) {
                    throw new Error('Invalid PayPal response');
                }

                // Create transaction entry
                // TODO: This is failing at db.collection
                // TODO: add target user name
                // TODO: make sure everything is correct before adding to db so that transaction doesn't get added if something else fails, or
                // payment goes out but transaction fails.
                const transactionEntry = {
                    targetUserId: payment.payeeId,
                    // target user name
                    campaignId: campaign.id,
                    amount: payment.amountOwed,
                    type: "creatorPayout",
                    source: "videoViews",
                    actorId: actorId,
                    actorName: actorName,
                    status: "completed",
                    currency: "USD",
                    paymentMethod: "paypal",
                    paymentReference: payoutResult.batch_header.payout_batch_id,
                    createdAt: FieldValue.serverTimestamp(),
                    metadata: {
                        videoIds: payment.videos.map(v => v.id),
                        views: payment.videos.map(v => v.views),
                        ratePerMillion: campaign.ratePerMillion || 0,
                        payoutBatchId: payoutResult.batch_header.payout_batch_id,
                        timestamp: FieldValue.serverTimestamp(),
                        paymentEmail: payment.paymentEmail,
                        videoCount: payment.videos.length,
                        totalViews: payment.videos.reduce((sum, v) => sum + (v.views || 0), 0),
                        platformFee: 0,
                        netAmount: payment.amountOwed,
                        paymentStatus: "completed",
                        reconciliationId: `PAY-${Date.now()}-${payment.payeeId}`
                    }
                };

                await db.collection('transactions').add(transactionEntry);

                // Update all videos for this user as paid
                const batch = db.batch();
                payment.videos.forEach(video => {
                    const videoRef = db.collection('campaigns')
                        .doc(campaignId)
                        .collection('videos')
                        .doc(video.id);
                    batch.update(videoRef, { 
                        hasBeenPaid: true,
                        payoutAmountForVideo: video.earnings,
                        paidBy: actorId,
                        paidByName: actorName,
                        paidAt: FieldValue.serverTimestamp()
                    });
                });
                await batch.commit();

                // Create receipt
                const receipt = {
                    receiptId: `REC-${Date.now()}-${payment.payeeId}`,
                    campaignId: campaignId,
                    creator: {
                        id: payment.payeeId,
                        firstName: payment.firstName,
                        lastName: payment.lastName,
                        email: payment.email,
                        paymentEmail: payment.creatorPaymentEmail
                    },
                    payment: {
                        amount: payment.amountOwed,
                        currency: "USD",
                        status: "completed",
                        method: "paypal",
                        batchId: payoutResult.batch_header.payout_batch_id,
                        timestamp: FieldValue.serverTimestamp()
                    },
                    videos: {
                        paid: payment.videos.map(video => ({
                            id: video.id,
                            title: video.title,
                            views: video.views,
                            earnings: video.earnings,
                            ratePerMillion: video.ratePerMillion
                        })),
                        unpaid: payments.unpaidVideos
                    },
                    summary: {
                        totalVideos: payment.videos.length,
                        totalViews: payment.videos.reduce((sum, v) => sum + (v.views || 0), 0),
                        averageRatePerMillion: payment.videos.reduce((sum, v) => sum + (v.ratePerMillion || 0), 0) / payment.videos.length,
                        platformFee: 0,
                        netAmount: payment.amountOwed,
                        unpaidVideosCount: payments.unpaidVideos.length
                    },
                    metadata: {
                        processedBy: {
                            id: actorId,
                            name: actorName
                        },
                        transactionId: transactionEntry.metadata.reconciliationId,
                        paymentReference: payoutResult.batch_header.payout_batch_id
                    }
                };

                // Add receipt to campaign document
                const campaignRef = db.collection('campaigns').doc(campaignId);
                await campaignRef.update({
                    receipts: FieldValue.arrayUnion(receipt)
                });

            } catch (error) {
                hasErrors = true;
                console.error(`Error processing payment for creator ${payment.payeeId}:`, error);
                throw error; // Re-throw to be caught by outer try-catch
            }
        }

        if (hasErrors) {
            throw new Error('One or more payments failed to process');
        }

        return { success: true };
    } catch (error) {
        console.error('Error in payCreator:', error);
        throw error;
    }
}
