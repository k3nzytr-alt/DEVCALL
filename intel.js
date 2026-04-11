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
const FETCH_TIMEOUT = 12000;               // 12 sec max per standard API call
const BLOXBIZ_TIMEOUT = 25000;             // 25 sec for heavy metadata (dev products)
const DASHBOARD_TTL = 60 * 60 * 1000;      // 1 hour — dashboard stays interactive

// Timeout-wrapped fetch
function timedFetch(url, opts = {}, customTimeout = FETCH_TIMEOUT) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), customTimeout);
    return fetch(url, { ...opts, signal: controller.signal })
        .finally(() => clearTimeout(timeout));
}

// ---- UI Builders ----
function getComponents(tab, subtab, page, maxPages) {
    const row1 = new ActionRowBuilder()
        .addComponents(
            new ButtonBuilder().setCustomId('intel_tab_general').setLabel('General').setStyle(tab === 'general' ? ButtonStyle.Primary : ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId('intel_tab_monetization').setLabel('Monetisation').setStyle(tab === 'monetization' ? ButtonStyle.Primary : ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId('intel_tab_retention').setLabel('Retention').setStyle(tab === 'retention' ? ButtonStyle.Primary : ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId('intel_tab_discovery').setLabel('Discovery').setStyle(tab === 'discovery' ? ButtonStyle.Primary : ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId('intel_tab_media').setLabel('Media').setStyle(tab === 'media' ? ButtonStyle.Primary : ButtonStyle.Secondary)
        );

    const components = [row1];

    // Monetisation sub-tab row
    if (tab === 'monetization') {
        const row2 = new ActionRowBuilder()
            .addComponents(
                new ButtonBuilder().setCustomId('intel_subtab_passes').setLabel('Gamepasses').setStyle(subtab === 'passes' ? ButtonStyle.Primary : ButtonStyle.Secondary),
                new ButtonBuilder().setCustomId('intel_subtab_products').setLabel('Developer Products').setStyle(subtab === 'products' ? ButtonStyle.Primary : ButtonStyle.Secondary)
            );
        components.push(row2);
    }

    // Pagination row
    const needsPagination = (tab === 'retention' || tab === 'media' || (tab === 'monetization' && subtab)) && maxPages > 1;
    if (needsPagination) {
        const paginationRow = new ActionRowBuilder()
            .addComponents(
                new ButtonBuilder().setCustomId('intel_page_prev').setLabel('◀').setStyle(ButtonStyle.Secondary).setDisabled(page === 0),
                new ButtonBuilder().setCustomId('intel_page_indicator').setLabel(`Page ${page + 1}/${maxPages}`).setStyle(ButtonStyle.Secondary).setDisabled(true),
                new ButtonBuilder().setCustomId('intel_page_next').setLabel('▶').setStyle(ButtonStyle.Secondary).setDisabled(page >= maxPages - 1)
            );
        components.push(paginationRow);
    }

    return components;
}

const formatNum = (val) => val == null ? 'N/A' : Math.ceil(Number(val)).toLocaleString();
const formatChange = (change) => change == null ? '' : ` (${change > 0 ? '+' : ''}${Math.ceil(change)}%)`;

// ---- Daily Deterministic Variance ----
function getDailyVariance(universeId, baseValue) {
    if (!baseValue) return 0;
    
    // Create seed from UniverseID + UTC Date (YYYY-MM-DD)
    const dateStr = new Date().toISOString().split('T')[0]; 
    const seedStr = universeId.toString() + "-" + dateStr;
    
    // Hash string to 32-bit integer
    let hash = 0;
    for (let i = 0; i < seedStr.length; i++) {
        hash = Math.imul(31, hash) + seedStr.charCodeAt(i) | 0;
    }
    
    // Mulberry32 PRNG logic to get float from 0 to 1
    let t = hash += 0x6D2B79F5;
    t = Math.imul(t ^ t >>> 15, t | 1);
    t ^= t + Math.imul(t ^ t >>> 7, t | 61);
    const rand = ((t ^ t >>> 14) >>> 0) / 4294967296;
    
    // Translate random scale to bounds -1.0 to 1.0
    const multiplier = (rand * 2) - 1;
    
    // Max variance scales exponentially to favor smaller amounts with higher padding
    const maxVariance = Math.pow(baseValue, 0.80); 
    
    return Math.floor(multiplier * maxVariance);
}

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
            // Memory Leak Fix: Auto-evict from cache
            setTimeout(() => discordInviteCache.delete(inviteCode), INVITE_CACHE_TTL);
            return info;
        }
    } catch (e) { }
    return null;
}

// ---- Embed Generator ----
async function getEmbed(data, tab, page) {
    const subtab = data.subtab || null;
    const embed = new EmbedBuilder().setColor(tab === 'general' ? '#00A2FF' : (tab === 'monetization' ? '#ffcc00' : (tab === 'retention' ? '#ff3366' : (tab === 'discovery' ? '#9d00ff' : (tab === 'media' ? '#22ff00' : '#ffffff')))));

    if (tab === 'general') {
        embed.setTitle(`DevCall$ Intel: ${data.info?.name || 'Unknown'}`);
        embed.setDescription(`[View on Roblox](https://www.roblox.com/games/${data.placeId})`);

        const kpi = data.kpi;
        if (kpi) {
            embed.addFields(
                { name: 'Live Players', value: `${formatNum(kpi.playing?.current?.value)}${formatChange(kpi.playing?.week?.percent_change)}`, inline: true },
                { name: 'Visits', value: `${formatNum(kpi.visits?.current?.value)}${formatChange(kpi.visits?.week?.percent_change)}`, inline: true },
                { name: 'Avg Session', value: `${kpi.session_length?.current?.value ? Math.ceil(kpi.session_length.current.value) + 'm' : 'N/A'}${formatChange(kpi.session_length?.week?.percent_change)}`, inline: true }
            );
            if (kpi.revenue?.current?.value) {
                const baseRev = kpi.revenue.current.value;
                const variance = getDailyVariance(data.universeId, baseRev);
                const variedRev = Math.max(0, baseRev + variance);
                embed.addFields({ name: 'Daily Avg Revenue (7D)', value: `R$${formatNum(variedRev)}${formatChange(kpi.revenue?.week?.percent_change)}`, inline: false });
            }
        }

        if (data.votes) {
            const total = data.votes.upVotes + data.votes.downVotes;
            const ratio = total > 0 ? Math.ceil((data.votes.upVotes / total) * 100) : 0;
            embed.addFields({ name: 'Sentiment', value: `**${ratio}%** Approval\n(${formatNum(data.votes.upVotes)} 👍 / ${formatNum(data.votes.downVotes)} 👎)`, inline: true });
        }

        if (data.info) {
            embed.addFields({ name: 'Timeline', value: `**Launched:** <t:${Math.floor(new Date(data.info.created).getTime() / 1000)}:d>\n**Last Updated:** <t:${Math.floor(new Date(data.info.updated).getTime() / 1000)}:R>\n**Universe ID:** \`${data.universeId}\``, inline: true });
        }

        if (data.thumbnailUrl) embed.setImage(data.thumbnailUrl);
    }
    else if (tab === 'monetization') {
        embed.setTitle(`Monetisation Breakdown`);

        // Revenue header — always shown
        const kpi = data.kpi;
        if (kpi?.revenue?.current?.value) {
            const baseRev = kpi.revenue.current.value;
            const variance = getDailyVariance(data.universeId, baseRev);
            const variedRev = Math.max(0, baseRev + variance);
            embed.addFields({ name: 'Daily Avg Revenue (7D)', value: `R$${formatNum(variedRev)}${formatChange(kpi.revenue?.week?.percent_change)}`, inline: false });
        }

        if (!subtab) {
            // Overview — no sub-tab selected yet
            const passCount = data.bloxbizPasses?.length ?? data.gamepasses?.length ?? 0;
            const productCount = data.bloxbizProducts?.length ?? 0;
            embed.setDescription(`[Visit Game](https://www.roblox.com/games/${data.placeId})\n\n**${passCount}** Gamepasses · **${productCount}** Developer Products\n\n*Select a category below ↓*`);
        } else if (subtab === 'passes') {
            const passes = data.bloxbizPasses?.length > 0 ? data.bloxbizPasses : data.gamepasses || [];
            if (passes.length === 0) {
                embed.setDescription(`[Visit Game](https://www.roblox.com/games/${data.placeId})\n\nNo gamepasses found.`);
            } else {
                const start = page * 5;
                const chunk = passes.slice(start, start + 5);
                let desc = `**${passes.length} Gamepass${passes.length !== 1 ? 'es' : ''}:**\n`;
                for (const pass of chunk) {
                    const price = pass.price != null ? `R$${formatNum(pass.price)}` : (pass.PriceInRobux != null ? `R$${formatNum(pass.PriceInRobux)}` : 'Offsale');
                    const created = pass.created ? `<t:${Math.floor(new Date(pass.created).getTime() / 1000)}:d>` : '';
                    const id = pass.id || pass.gamePassId;
                    desc += `\n**${id ? `[${pass.name}](https://www.roblox.com/game-pass/${id})` : pass.name}**\nPrice: **${price}**${created ? ` · ${created}` : ''}\n`;
                }
                embed.setDescription(desc);
            }
        } else if (subtab === 'products') {
            const products = data.bloxbizProducts || [];
            if (data.bloxbizError) {
                embed.setDescription(`[Visit Game](https://www.roblox.com/games/${data.placeId})\n\ndata fetch error`);
            } else if (products.length === 0) {
                embed.setDescription(`[Visit Game](https://www.roblox.com/games/${data.placeId})\n\nNo developer products found.`);
            } else {
                const start = page * 5;
                const chunk = products.slice(start, start + 5);
                let desc = `**${products.length} Developer Product${products.length !== 1 ? 's' : ''}:**\n`;
                for (const p of chunk) {
                    const price = p.price != null ? `R$${formatNum(p.price)}` : (p.price_in_robux != null ? `R$${formatNum(p.price_in_robux)}` : 'N/A');
                    desc += `\n**${p.name}**\nPrice: **${price}**\n`;
                }
                embed.setDescription(desc);
            }
        }
    }
    else if (tab === 'retention') {
        embed.setTitle(`Player Stickiness & Retention`);
        const coreBadges = data.coreBadges || [];

        if (coreBadges.length === 0) {
            embed.setDescription(`[Visit Game](https://www.roblox.com/games/${data.placeId})\n\nNo core progression analytics data found.`);
        } else {
            // Starter badge = highest awarded
            const starterBadge = coreBadges[0];
            const starterAwards = starterBadge.statistics?.awardedCount || 0;

            let desc = `**True Drop-off Tracking:**\n*(Percentage of players who kept playing after the first badge)*\n`;

            const start = page * 5;
            const chunk = coreBadges.slice(start, start + 5);

            for (const badge of chunk) {
                const awards = badge.statistics?.awardedCount || 0;
                const apiWinRate = badge.statistics?.winRatePercentage !== undefined ? Math.ceil(badge.statistics.winRatePercentage * 100) + '%' : 'N/A';
                const trueRetention = starterAwards > 0 ? Math.ceil((awards / starterAwards) * 100) + '%' : 'N/A';

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
    else if (tab === 'media') {
        embed.setTitle(`Game Media & Thumbnails`);
        if (!data.mediaUrls || data.mediaUrls.length === 0) {
            embed.setDescription(`[Visit Game](https://www.roblox.com/games/${data.placeId})\n\nNo promotional artwork or thumbnails found.`);
        } else {
            embed.setDescription(`[Visit Game](https://www.roblox.com/games/${data.placeId})\n\nThumbnail **${page + 1}** of **${data.mediaUrls.length}**`);
            embed.setImage(data.mediaUrls[page]);
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
    const [kpiRes, mediaRes, infoRes, voteRes, passRes, badgeRes, discordRes, simRes, bloxbizRes] = await Promise.allSettled([
        timedFetch(`https://api.creatorexchange.io/v2/metrics/latest/kpi_trends?universeIds=${universeId}`, fetchOpts),
        timedFetch(`https://games.roblox.com/v2/games/${universeId}/media`, fetchOpts),
        timedFetch(`https://games.roblox.com/v1/games?universeIds=${universeId}`, fetchOpts),
        timedFetch(`https://games.roblox.com/v1/games/votes?universeIds=${universeId}`, fetchOpts),
        timedFetch(`https://apis.roblox.com/game-passes/v1/universes/${universeId}/game-passes?limit=100`, fetchOpts),
        timedFetch(`https://badges.roblox.com/v1/universes/${universeId}/badges?limit=100`, fetchOpts),
        timedFetch(`https://creatorexchange.io/api/v2/metrics/historical/discord_metrics?universeIds=${universeId}&granularity=DAY&start=${weekAgo}&end=${now}`, fetchOpts),
        timedFetch(`https://games.roblox.com/v1/games/recommendations/game/${universeId}?maxRows=5`, fetchOpts),
        timedFetch(`https://portal-api.bloxbiz.com/explore/games/${universeId}/details?fields=dev_products,gamepasses`, fetchOpts, BLOXBIZ_TIMEOUT)
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
        
        const imageIds = dataObj.media.filter(m => m.assetType === 'Image').map(m => m.imageId);
        dataObj.mediaUrls = [];
        
        if (imageIds.length > 0) {
            try {
                // Fetch all thumbnails in one bulk request
                const thumbRes = await timedFetch(`https://thumbnails.roblox.com/v1/assets?assetIds=${imageIds.join(',')}&returnPolicy=PlaceHolder&size=768x432&format=Png&isCircular=false`);
                if (thumbRes.ok) {
                    const thumbData = await thumbRes.json();
                    if (thumbData.data) {
                        dataObj.mediaUrls = thumbData.data.map(t => t.imageUrl).filter(u => u);
                        if (dataObj.mediaUrls.length > 0) {
                            dataObj.thumbnailUrl = dataObj.mediaUrls[0]; // Set primary thumbnail
                        }
                    }
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

    if (bloxbizRes.status === 'fulfilled' && bloxbizRes.value.ok) {
        try {
            const d = await bloxbizRes.value.json();
            if (d.data?.game?.gamepasses) dataObj.bloxbizPasses = d.data.game.gamepasses;
            if (d.data?.game?.dev_products) dataObj.bloxbizProducts = d.data.game.dev_products;
        } catch (e) {
            console.error('[INTEL] Failed to parse Bloxbiz JSON:', e);
            dataObj.bloxbizError = true;
        }
    } else if (bloxbizRes.status === 'rejected' || (bloxbizRes.value && !bloxbizRes.value.ok)) {
        console.error('[INTEL] Bloxbiz fetch failed or timed out');
        dataObj.bloxbizError = true;
    }

    if (badgeRes.status === 'fulfilled' && badgeRes.value.ok) {
        const d = await badgeRes.value.json();
        if (d.data) {
            const sortedBadges = d.data.sort((a, b) => (b.statistics?.awardedCount || 0) - (a.statistics?.awardedCount || 0));
            dataObj.badges = sortedBadges;
            
            const eventKeywords = ['event', '2022', '2023', '2024', '2025', '2026', 'hunt', 'classic', 'halloween', 'christmas', 'xmas', 'summer', 'winter', 'easter', 'egg', 'valentine', 'new year', 'holiday'];
            dataObj.coreBadges = sortedBadges.filter(b => {
                const nameLower = b.name.toLowerCase();
                return !eventKeywords.some(k => nameLower.includes(k));
            });
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
    // Memory Leak Fix: Auto-evict from map
    setTimeout(() => userCooldowns.delete(userId), USER_COOLDOWN);

    const placeId = placeIdMatch[1];
    await interaction.deferReply();

    try {
        const fetchOpts = { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' } };
        const dataObj = await fetchGameData(placeId, fetchOpts);

        if (!dataObj) return interaction.editReply('Failed to find universe ID for that game.');

        const embed = await getEmbed(dataObj, 'general', 0);
        const components = getComponents('general', null, 0, 1);

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
        return interaction.reply({ content: 'Slow down', ephemeral: true });
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
        const components = getComponents('general', null, 0, 1);
        
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
        // Default monetization to gamepasses sub-tab immediately
        dataObj.subtab = dataObj.tab === 'monetization' ? 'passes' : null;
        dataObj.page = 0;
    } else if (cid.startsWith('intel_subtab_')) {
        dataObj.subtab = cid.replace('intel_subtab_', '');
        dataObj.page = 0; // Reset page on subtab switch
    } else if (cid === 'intel_page_next') {
        dataObj.page += 1;
    } else if (cid === 'intel_page_prev') {
        dataObj.page -= 1;
    }

    let listSize = 0;
    let itemsPerPage = 5;

    if (dataObj.tab === 'monetization') {
        if (dataObj.subtab === 'passes') {
            listSize = dataObj.bloxbizPasses?.length ?? dataObj.gamepasses?.length ?? 0;
        } else if (dataObj.subtab === 'products') {
            listSize = dataObj.bloxbizProducts?.length ?? 0;
        }
    } else if (dataObj.tab === 'retention') {
        listSize = dataObj.coreBadges?.length || 0;
    } else if (dataObj.tab === 'media') {
        listSize = dataObj.mediaUrls?.length || 0;
        itemsPerPage = 1;
    }

    const maxPages = (dataObj.tab === 'general' || dataObj.tab === 'discovery' || (dataObj.tab === 'monetization' && !dataObj.subtab)) ? 1 : Math.ceil(listSize / itemsPerPage);

    const embed = await getEmbed(dataObj, dataObj.tab, dataObj.page);
    const components = getComponents(dataObj.tab, dataObj.subtab, dataObj.page, maxPages);

    await interaction.update({ embeds: [embed], components });
}

module.exports = { handleIntelCommand, handleIntelButton, fetchGameData };
