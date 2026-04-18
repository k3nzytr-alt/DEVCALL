const { EmbedBuilder } = require('discord.js');
const db = require('./database.js');

const TRACKER_CHANNEL_ID = '1494949999539388456';
const TRACK_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours


const TRACKED_ACCOUNTS = [
    // indigo
    10467300907, // indigo
    5370600313, // matthew indigo
    9969715259, //indigo metrics
    9315181577, // indigo offical data

    // misfits
    2735356267, // misfits
    10019828168, // misfitsTOO

    // dobig
    2243026817, // const
    5080868749, // johnny
    5119318514, // blade exec
    8391888266, // do revenue bot

    // creator games
    9341949905, // david

    // buyers
    102108028, // pariet    
    5420068, // hiddo
    111233359, // preston
    8566023830, // preston 2
    1046851536, // marcus
    1657140835, // inc
    157392877, // brandon
    10424163858, // manuel
    7884980323, // charles
    2012478972, // jaay
    7627847305, // devnameddavid
];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function fetchWithRetry(url, options = {}, retries = 3) {
    for (let i = 0; i < retries; i++) {
        try {
            const res = await fetch(url, options);
            if (!res.ok) {
                if (res.status === 429) {
                    await sleep(2000 * (i + 1));
                    continue;
                }
                throw new Error(`HTTP ${res.status}`);
            }
            return await res.json();
        } catch (error) {
            if (i === retries - 1) throw error;
            await sleep(1000);
        }
    }
    return null;
}

async function checkTrackedAccount(client, userId) {
    try {
        // 1. Get the user's groups and roles
        const groupsData = await fetchWithRetry(`https://groups.roblox.com/v1/users/${userId}/groups/roles`);
        if (!groupsData || !groupsData.data) return;

        // 2. Get user info for embed
        let username = `User ID: ${userId}`;
        let headshotUrl = null;
        try {
            const userInfo = await fetchWithRetry(`https://users.roblox.com/v1/users/${userId}`);
            if (userInfo && userInfo.displayName) {
                username = userInfo.name !== userInfo.displayName ? `${userInfo.displayName} (@${userInfo.name})` : `@${userInfo.name}`;
            }

            const avatarData = await fetchWithRetry(`https://thumbnails.roblox.com/v1/users/avatar-headshot?userIds=${userId}&size=150x150&format=Png&isCircular=false`);
            if (avatarData && avatarData.data && avatarData.data.length > 0) {
                headshotUrl = avatarData.data[0].imageUrl;
            }
        } catch (e) {
            console.error(`Failed to fetch user info for ${userId}`);
        }

        const channel = await client.channels.fetch(TRACKER_CHANNEL_ID).catch(() => null);
        // 3. Collect all groups they are heavily ranked in at this snapshot
        const activeGroupMap = new Map();
        for (const group of groupsData.data) {
            if (group.role.rank > 1) {
                activeGroupMap.set(group.group.id, group);
            }
        }

        // 4. Compare with DB History
        const previousHistory = db.getTrackerHistory(userId);
        const newGroupIds = Array.from(activeGroupMap.keys()).filter(id => !previousHistory.includes(id));

        // If they acquired a MASSIVE amount of groups suddenly (or if the bot crashed midway through the first boot's save)
        // just silently sync the state to prevent 50 spam embeds. Realistically they only acquire 1-2 groups in 6 hours.
        if (newGroupIds.length > 2 || previousHistory.length === 0) {
            db.syncTrackerHistory(userId, Array.from(activeGroupMap.keys()));
            return;
        }

        // Genuine new acquisition! Loop through the 1 or 2 new groups and alert
        for (const groupId of newGroupIds) {
            const groupData = activeGroupMap.get(groupId);
            const role = groupData.role;
            const groupInfo = groupData.group;

            // Fetch group's games
            let gamesList = [];
            try {
                const gamesData = await fetchWithRetry(`https://games.roblox.com/v2/groups/${groupId}/games?accessFilter=Public&sortOrder=Asc&limit=10`);
                if (gamesData && gamesData.data) {
                    gamesList = gamesData.data;
                }
            } catch (e) { }

            // Fetch Group Logo
            let groupIconUrl = null;
            try {
                const iconData = await fetchWithRetry(`https://thumbnails.roblox.com/v1/groups/icons?groupIds=${groupId}&size=150x150&format=Png&isCircular=false`);
                if (iconData && iconData.data && iconData.data.length > 0) {
                    groupIconUrl = iconData.data[0].imageUrl;
                }
            } catch (e) { }

            // Build Embed
            const embed = new EmbedBuilder()
                .setColor('#ffcc00')
                .setAuthor({ name: 'Acquisition Tracker', iconURL: headshotUrl || undefined })
                .setTitle(`${username} was ranked in a Group!`)
                .setThumbnail(groupIconUrl || undefined)
                .setDescription(`**Group:** [${groupInfo.name}](https://www.roblox.com/groups/${groupInfo.id})\n**Added Rank:** \`${role.name}\` (Rank: ${role.rank})\n**Member Count:** ${groupInfo.memberCount.toLocaleString()}`)
                .setTimestamp();

            if (gamesList.length > 0) {
                let gamesText = '';
                const topGames = gamesList.slice(0, 5); 
                for (const game of topGames) {
                    gamesText += `🎮 [${game.name}](https://www.roblox.com/games/${game.rootPlace.id})\n`;
                }
                if (gamesList.length > 5) {
                    gamesText += `*...and ${gamesList.length - 5} more games.*`;
                }
                embed.addFields({ name: 'Attached Games', value: gamesText });
            } else {
                embed.addFields({ name: 'Attached Games', value: 'No public games attached to this group.' });
            }

            // Send Alert
            await channel.send({ embeds: [embed] });
            
            // Save history incrementally just in case it drops
            db.markTrackedAlert(userId, groupInfo.id);
            await sleep(2000); // Dodge discord API spikes
        }
        
        // Final sync of the complete picture
        db.syncTrackerHistory(userId, Array.from(activeGroupMap.keys()));

    } catch (err) {
        console.error(`[Tracker] Error checking account ${userId}:`, err);
    }
}

async function runTrackerCycle(client) {
    if (TRACKED_ACCOUNTS.length === 0) return;
    console.log('[Tracker] Starting acquisition tracker cycle...');
    for (const userId of TRACKED_ACCOUNTS) {
        await checkTrackedAccount(client, userId);
        // Delay between parsing each massive account to spare our IP from 429s.
        await sleep(5000);
    }
    console.log('[Tracker] Finished acquisition tracker cycle.');
}

module.exports = {
    start: (client) => {
        // Run immediately once on startup (optional, we could wait, but useful for testing)
        // Set timeout to let bot boot up fully first
        setTimeout(() => {
            runTrackerCycle(client);
            setInterval(() => runTrackerCycle(client), TRACK_INTERVAL_MS);
        }, 10000);
    }
};
