const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');

// ---- Caches ----
const intelCache = new Map();       // messageId -> dataObj (per-dashboard state)
const gameDataCache = new Map();    // universeId -> { data, timestamp }  (shared across users)
const discordInviteCache = new Map(); // inviteCode -> { total, online, timestamp }
const userCooldowns = new Map();    // userId -> timestamp (command)
const buttonCooldowns = new Map();  // userId -> timestamp (buttons)

const GAME_CACHE_TTL = 5 * 60 * 1000;     // 5 min — same game won't re-fetch
const INVITE_CACHE_TTL = 10 * 60 * 1000;  // 10 min — Discord member counts
const USER_COOLDOWN = 5 * 1000;            // 5 sec between /intel calls per user
const BUTTON_COOLDOWN = 1500;              // 1.5 sec between button clicks
const FETCH_TIMEOUT = 8000;                // 8 sec max per API call
const DASHBOARD_TTL = 60 * 60 * 1000;      // 1 hour — dashboard stays interactive

// Timeout-wrapped fetch
function timedFetch(url, opts = {}) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT);
    return fetch(url, { ...opts, signal: controller.signal })
        .finally(() => clearTimeout(timeout));
}

// ---- UI Builders ----
function getComponents(tab, page, maxPages) {
    const row1 = new ActionRowBuilder()
        .addComponents(
            new ButtonBuilder().setCustomId('intel_tab_general').setLabel('General').setStyle(tab === 'general' ? ButtonStyle.Primary : ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId('intel_tab_monetization').setLabel('Monetization').setStyle(tab === 'monetization' ? ButtonStyle.Primary : ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId('intel_tab_retention').setLabel('Retention').setStyle(tab === 'retention' ? ButtonStyle.Primary : ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId('intel_tab_discovery').setLabel('Discovery').setStyle(tab === 'discovery' ? ButtonStyle.Primary : ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId('intel_tab_servers').setLabel('Servers').setStyle(tab === 'servers' ? ButtonStyle.Primary : ButtonStyle.Secondary)
        );

    // Only show pagination row if we are on a paginated tab and there's more than 1 page
    if ((tab === 'monetization' || tab === 'retention') && maxPages > 1) {
        const row2 = new ActionRowBuilder()
            .addComponents(
                new ButtonBuilder().setCustomId('intel_page_prev').setLabel('◀').setStyle(ButtonStyle.Secondary).setDisabled(page === 0),
                new ButtonBuilder().setCustomId('intel_page_indicator').setLabel(`Page ${page + 1}/${maxPages}`).setStyle(ButtonStyle.Secondary).setDisabled(true),
                new ButtonBuilder().setCustomId('intel_page_next').setLabel('▶').setStyle(ButtonStyle.Secondary).setDisabled(page >= maxPages - 1)
            );
        return [row1, row2];
    }

    return [row1];
}

const formatNum = (val) => val == null ? 'N/A' : Number(val).toLocaleString(undefined, { maximumFractionDigits: 0 });
const formatChange = (change) => change == null ? '' : ` (${change > 0 ? '+' : ''}${change.toFixed(1)}%)`;

// ---- Cached Discord invite lookup ----
async function getDiscordInviteInfo(inviteCode) {
    const cached = discordInviteCache.get(inviteCode);
    if (cached && Date.now() - cached.timestamp < INVITE_CACHE_TTL) return cached;

    try {
        const r = await timedFetch(`https://discord.com/api/v9/invites/${inviteCode}?with_counts=true`);
        if (r.ok) {
            const d = await r.json();
            const info = {
                total: d.approximate_member_count || 0,
                online: d.approximate_presence_count || 0,
                timestamp: Date.now()
            };
            discordInviteCache.set(inviteCode, info);
            return info;
        }
    } catch (e) { }
    return null;
}

// ---- Embed Generator ----
async function getEmbed(data, tab, page) {
    const embed = new EmbedBuilder().setColor(tab === 'general' ? '#00A2FF' : (tab === 'monetization' ? '#ffcc00' : (tab === 'retention' ? '#ff3366' : (tab === 'discovery' ? '#9d00ff' : '#22ff00'))));

    if (tab === 'general') {
        embed.setTitle(`DevCall$ Intel: ${data.info?.name || 'Unknown'}`);
        embed.setDescription(`[View on Roblox](https://www.roblox.com/games/${data.placeId})`);

        const kpi = data.kpi;
        if (kpi) {
            embed.addFields(
                { name: 'Live Players', value: `${formatNum(kpi.playing?.current?.value)}${formatChange(kpi.playing?.week?.percent_change)}`, inline: true },
                { name: 'Visits', value: `${formatNum(kpi.visits?.current?.value)}${formatChange(kpi.visits?.week?.percent_change)}`, inline: true },
                { name: 'Avg Session', value: `${kpi.session_length?.current?.value ? kpi.session_length.current.value.toFixed(1) + 'm' : 'N/A'}${formatChange(kpi.session_length?.week?.percent_change)}`, inline: true }
            );
            if (kpi.revenue?.current?.value) {
                embed.addFields({ name: 'Daily Avg Revenue (7D)', value: `R$${formatNum(kpi.revenue.current.value)}${formatChange(kpi.revenue?.week?.percent_change)}`, inline: false });
            }
        }

        if (data.votes) {
            const total = data.votes.upVotes + data.votes.downVotes;
            const ratio = total > 0 ? ((data.votes.upVotes / total) * 100).toFixed(1) : 0;
            embed.addFields({ name: 'Sentiment', value: `**${ratio}%** Approval\n(${formatNum(data.votes.upVotes)} 👍 / ${formatNum(data.votes.downVotes)} 👎)`, inline: true });
        }

        if (data.info) {
            embed.addFields({ name: 'Timeline', value: `**Launched:** <t:${Math.floor(new Date(data.info.created).getTime() / 1000)}:d>\n**Last Updated:** <t:${Math.floor(new Date(data.info.updated).getTime() / 1000)}:R>\n**Universe ID:** \`${data.universeId}\``, inline: true });
        }

        if (data.thumbnailUrl) embed.setImage(data.thumbnailUrl);
    }
    else if (tab === 'monetization') {
        embed.setTitle(`Monetization Breakdown`);
        embed.setDescription(`[Visit Game](https://www.roblox.com/games/${data.placeId})`);

        const passes = data.gamepasses;
        if (!passes || passes.length === 0) {
            embed.addFields({ name: 'Status', value: 'No gamepasses linked to this game.' });
        } else {
            const start = page * 5;
            const chunk = passes.slice(start, start + 5);

            const pricePromises = chunk.map(async (pass) => {
                try {
                    const r = await timedFetch(`https://apis.roblox.com/game-passes/v1/game-passes/${pass.id}/product-info`);
                    if (r.ok) {
                        const d = await r.json();
                        return d.PriceInRobux;
                    }
                } catch (e) { }
                return null;
            });
            const prices = await Promise.all(pricePromises);

            let desc = `**Found ${passes.length} Assets:**\n`;
            for (let i = 0; i < chunk.length; i++) {
                const pass = chunk[i];
                const priceStr = prices[i] !== null ? `R$${formatNum(prices[i])}` : 'Offsale';
                desc += `\n**[${pass.name}](https://www.roblox.com/game-pass/${pass.id})**\nPrice: **${priceStr}** · <t:${Math.floor(new Date(pass.created).getTime() / 1000)}:d>\n`;
            }
            embed.setDescription(desc);
        }
    }
    else if (tab === 'retention') {
        embed.setTitle(`Player Stickiness & Retention`);
        const badges = data.badges;
        const totalVisits = data.kpi?.visits?.current?.value || data.info?.visits || 1;

        if (!badges || badges.length === 0) {
            embed.setDescription(`[Visit Game](https://www.roblox.com/games/${data.placeId})\n\nNo analytics data found (No badges).`);
        } else {
            // Starter badge = highest awarded
            const starterBadge = badges[0];
            const starterAwards = starterBadge.statistics?.awardedCount || 0;

            let desc = `**True Drop-off Tracking:**\n*(Percentage of players who kept playing after the first badge)*\n`;

            const start = page * 5;
            const chunk = badges.slice(start, start + 5);

            for (const badge of chunk) {
                const awards = badge.statistics?.awardedCount || 0;
                const apiWinRate = badge.statistics?.winRatePercentage !== undefined ? (badge.statistics.winRatePercentage * 100).toFixed(1) + '%' : 'N/A';
                const trueRetention = starterAwards > 0 ? ((awards / starterAwards) * 100).toFixed(1) + '%' : 'N/A';

                desc += `\n**${badge.name}**\nRetention: **${trueRetention}** (API: ${apiWinRate})\nAwarded: ${formatNum(awards)}\n`;
            }
            embed.setDescription(desc);
        }
    }
    else if (tab === 'discovery') {
        embed.setTitle(`Market Discovery`);

        // Community section — uses pre-cached Discord data
        let communityLines = 'No community data tracked.';
        if (data.discordInviteInfo) {
            const di = data.discordInviteInfo;
            communityLines = `🔗 [Discord](https://discord.gg/${data.discord.discord_invite_id}) — **${Number(di.total).toLocaleString()}** members (**${Number(di.online).toLocaleString()}** online)`;
        } else if (data.discord && data.discord.discord_invite_id) {
            // Fallback: fetch live if pre-cache missed
            const info = await getDiscordInviteInfo(data.discord.discord_invite_id);
            if (info) {
                data.discordInviteInfo = info;
                communityLines = `🔗 [Discord](https://discord.gg/${data.discord.discord_invite_id}) — **${Number(info.total).toLocaleString()}** members (**${Number(info.online).toLocaleString()}** online)`;
            }
        }

        // Similar games
        const similarLines = data.similar && data.similar.length > 0
            ? data.similar.slice(0, 5).map(g => {
                const players = g.playerCount ? ` (${Number(g.playerCount).toLocaleString()} playing)` : '';
                return `• [${g.name}](https://www.roblox.com/games/${g.placeId})${players}`;
            }).join('\n')
            : 'No similar games found.';

        embed.addFields(
            { name: 'Community', value: communityLines, inline: false },
            { name: 'Competitors', value: similarLines, inline: false }
        );

        if (data.thumbnailUrl) embed.setThumbnail(data.thumbnailUrl);
    }
    else if (tab === 'servers') {
        embed.setTitle(`Server Health Check`);

        try {
            const r = await timedFetch(`https://games.roblox.com/v1/games/${data.placeId}/servers/Public?sortOrder=Desc&limit=10`);
            const serverData = await r.json();
            if (!serverData.data || serverData.data.length === 0) {
                embed.setDescription(`[Visit Game](https://www.roblox.com/games/${data.placeId})\n\nGhost town. No active servers found.`);
            } else {
                let desc = `[Visit Game](https://www.roblox.com/games/${data.placeId})\n\n**Top 5 Clusters:**`;
                const top5 = serverData.data.slice(0, 5);
                for (const srv of top5) {
                    desc += `\n\n**Server:** \`${srv.id.substring(0, 8)}\`\nStatus: **${srv.playing}/${srv.maxPlayers} players**\nDiagnostics: **${srv.ping}ms** / **${srv.fps.toFixed(1)} FPS**`;
                }
                embed.setDescription(desc);
            }
        } catch (e) {
            embed.setDescription(`[Visit Game](https://www.roblox.com/games/${data.placeId})\n\nFailed to pulse-check servers.`);
        }
    }

    return embed;
}

// ---- Core data fetcher (with game-level caching) ----
async function fetchGameData(placeId, fetchOpts) {
    const uniRes = await timedFetch(`https://apis.roblox.com/universes/v1/places/${placeId}/universe`, fetchOpts);
    if (!uniRes.ok) return null;
    const uniData = await uniRes.json();
    const universeId = uniData.universeId;

    // Check game data cache
    const cached = gameDataCache.get(universeId);
    if (cached && Date.now() - cached.timestamp < GAME_CACHE_TTL) {
        // Return a fresh copy so each dashboard has its own tab/page state
        return { ...cached.data, tab: 'general', page: 0 };
    }

    const now = new Date().toISOString();
    const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const [kpiRes, mediaRes, infoRes, voteRes, passRes, badgeRes, discordRes, simRes] = await Promise.allSettled([
        timedFetch(`https://api.creatorexchange.io/v2/metrics/latest/kpi_trends?universeIds=${universeId}`, fetchOpts),
        timedFetch(`https://games.roblox.com/v2/games/${universeId}/media`, fetchOpts),
        timedFetch(`https://games.roblox.com/v1/games?universeIds=${universeId}`, fetchOpts),
        timedFetch(`https://games.roblox.com/v1/games/votes?universeIds=${universeId}`, fetchOpts),
        timedFetch(`https://apis.roblox.com/game-passes/v1/universes/${universeId}/game-passes?limit=100`, fetchOpts),
        timedFetch(`https://badges.roblox.com/v1/universes/${universeId}/badges?limit=100`, fetchOpts),
        timedFetch(`https://creatorexchange.io/api/v2/metrics/historical/discord_metrics?universeIds=${universeId}&granularity=DAY&start=${weekAgo}&end=${now}`, fetchOpts),
        timedFetch(`https://games.roblox.com/v1/games/recommendations/game/${universeId}?maxRows=5`, fetchOpts)
    ]);

    const dataObj = {
        placeId,
        universeId,
        tab: 'general',
        page: 0
    };

    if (kpiRes.status === 'fulfilled' && kpiRes.value.ok) {
        const d = await kpiRes.value.json();
        if (d.ok && d.kpiData && d.kpiData.length > 0) Object.assign(dataObj, { kpi: d.kpiData[0] });
    }

    if (mediaRes.status === 'fulfilled' && mediaRes.value.ok) {
        const d = await mediaRes.value.json();
        dataObj.media = d.data || [];
        const firstImage = dataObj.media.find(m => m.assetType === 'Image');
        if (firstImage && firstImage.imageId) {
            try {
                const thumbRes = await timedFetch(`https://thumbnails.roblox.com/v1/assets?assetIds=${firstImage.imageId}&returnPolicy=PlaceHolder&size=768x432&format=Png&isCircular=false`);
                if (thumbRes.ok) {
                    const thumbData = await thumbRes.json();
                    if (thumbData.data && thumbData.data.length > 0) dataObj.thumbnailUrl = thumbData.data[0].imageUrl;
                }
            } catch (e) { }
        }
    }

    if (infoRes.status === 'fulfilled' && infoRes.value.ok) {
        const d = await infoRes.value.json();
        if (d.data?.length > 0) dataObj.info = d.data[0];
    }

    if (voteRes.status === 'fulfilled' && voteRes.value.ok) {
        const d = await voteRes.value.json();
        if (d.data?.length > 0) dataObj.votes = d.data[0];
    }

    if (passRes.status === 'fulfilled' && passRes.value.ok) {
        const d = await passRes.value.json();
        if (d.gamePasses) dataObj.gamepasses = d.gamePasses;
    }

    if (badgeRes.status === 'fulfilled' && badgeRes.value.ok) {
        const d = await badgeRes.value.json();
        if (d.data) {
            dataObj.badges = d.data.sort((a, b) => (b.statistics?.awardedCount || 0) - (a.statistics?.awardedCount || 0));
        }
    }

    if (discordRes.status === 'fulfilled' && discordRes.value.ok) {
        const d = await discordRes.value.json();
        if (d.ok && d.kpiData && d.kpiData.length > 0) {
            dataObj.discord = d.kpiData[d.kpiData.length - 1];
            // Pre-cache Discord invite info so the Discovery tab is instant
            if (dataObj.discord.discord_invite_id) {
                const info = await getDiscordInviteInfo(dataObj.discord.discord_invite_id);
                if (info) dataObj.discordInviteInfo = info;
            }
        }
    }

    if (simRes.status === 'fulfilled' && simRes.value.ok) {
        const d = await simRes.value.json();
        dataObj.similar = d.games || [];
    }

    // Store in game data cache
    gameDataCache.set(universeId, { data: { ...dataObj }, timestamp: Date.now() });

    // Auto-evict after TTL to prevent memory leaks
    setTimeout(() => gameDataCache.delete(universeId), GAME_CACHE_TTL);

    return dataObj;
}

// ---- Slash command handler ----
async function handleIntelCommand(interaction) {
    const input = interaction.options.getString('game');
    const placeIdMatch = input.match(/(\d+)/);
    if (!placeIdMatch) return interaction.reply({ content: 'Invalid game link or ID. Please provide a valid place ID.', ephemeral: true });

    // Per-user cooldown
    const userId = interaction.user.id;
    const lastUse = userCooldowns.get(userId);
    if (lastUse && Date.now() - lastUse < USER_COOLDOWN) {
        const wait = Math.ceil((USER_COOLDOWN - (Date.now() - lastUse)) / 1000);
        return interaction.reply({ content: `Slow down — try again in ${wait}s.`, ephemeral: true });
    }
    userCooldowns.set(userId, Date.now());

    const placeId = placeIdMatch[1];
    await interaction.deferReply();

    try {
        const fetchOpts = { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' } };
        const dataObj = await fetchGameData(placeId, fetchOpts);

        if (!dataObj) return interaction.editReply('Failed to find universe ID for that game.');

        const embed = await getEmbed(dataObj, 'general', 0);
        const components = getComponents('general', 0, 1);

        const msg = await interaction.editReply({ embeds: [embed], components });
        dataObj.ownerId = interaction.user.id; // Only command user can click
        intelCache.set(msg.id, dataObj);

        setTimeout(() => intelCache.delete(msg.id), DASHBOARD_TTL);

    } catch (err) {
        console.error(err);
        await interaction.editReply('Error spinning up dashboard. (Check console for raw logs)');
    }
}

// ---- Button handler ----
async function handleIntelButton(interaction) {
    const userId = interaction.user.id;
 
    // 1. Per-user Rate Limit
    const lastClick = buttonCooldowns.get(userId);
    if (lastClick && Date.now() - lastClick < BUTTON_COOLDOWN) {
        return interaction.reply({ content: 'Slow down — button rate limit active.', ephemeral: true });
    }
    buttonCooldowns.set(userId, Date.now());
    setTimeout(() => buttonCooldowns.delete(userId), BUTTON_COOLDOWN);
 
    const dataObj = intelCache.get(interaction.message.id);
    if (!dataObj) {
        return interaction.reply({ content: 'This dashboard has expired. Please run `/intel` again.', ephemeral: true });
    }
 
    // 2. Owner-Only Check
    if (dataObj.ownerId !== userId) {
        return interaction.reply({ content: 'Only the user who ran the command can use these buttons.', ephemeral: true });
    }
 
    // 3. 1-Hour Age Check (Force Revert to General)
    const isTooOld = (Date.now() - interaction.message.createdTimestamp) > 3600000;
    if (isTooOld) {
        dataObj.tab = 'general';
        dataObj.page = 0;
        const embed = await getEmbed(dataObj, 'general', 0);
        const components = getComponents('general', 0, 1);
        
        await interaction.update({ 
            embeds: [embed], 
            components: components.map(row => {
                row.components.forEach(btn => btn.setDisabled(true));
                return row;
            })
        });
        
        intelCache.delete(interaction.message.id);
        return;
    }

    const cid = interaction.customId;
    if (cid.startsWith('intel_tab_')) {
        dataObj.tab = cid.replace('intel_tab_', '');
        dataObj.page = 0; // Reset page on tab switch
    } else if (cid === 'intel_page_next') {
        dataObj.page += 1;
    } else if (cid === 'intel_page_prev') {
        dataObj.page -= 1;
    }

    const listSize = dataObj.tab === 'monetization' ? (dataObj.gamepasses?.length || 0) : (dataObj.tab === 'retention' ? (dataObj.badges?.length || 0) : 0);
    const maxPages = dataObj.tab === 'discovery' ? 1 : Math.ceil(listSize / 5);

    const embed = await getEmbed(dataObj, dataObj.tab, dataObj.page);
    const components = getComponents(dataObj.tab, dataObj.page, maxPages);

    await interaction.update({ embeds: [embed], components });
}

module.exports = { handleIntelCommand, handleIntelButton, fetchGameData };
