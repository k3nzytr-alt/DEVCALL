require('dotenv').config();
const { Client, GatewayIntentBits, REST, Routes, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ComponentType, ActivityType } = require('discord.js');
const commandDefinitions = require('./commands.js');
const db = require('./database.js');
const intel = require('./intel.js');

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
    ],
});

// --- Server Whitelist ---
const ALLOWED_GUILDS = new Set([
    '1491889701882302614',
    '1394258598082904209'
]);

// --- Owner Lock ---
const OWNER_ID = '953039971172904980';
let isLocked = false;

// --- Safety Helper ---
// Strictly enforces that the target has "Aspiring dev". They may only have other roles if explicitly allowed (like a bulk command filter).
// Reaction roles are harmless skill tags — always ignored.
const REACTION_ROLES = new Set([
    'ui designers', 'buyers', 'top buyers', 'builder',
    'music composer', 'project manager', 'thumbnail artist',
    'vfx designer', 'animator', '3d modeler', 'programmer'
]);

function isTargetable(member, allowedExtraRoleIds = []) {
    if (!member) return false;
    if (member.user.bot) return false;
    
    // Member MUST have Aspiring dev
    const hasAspiringDev = member.roles.cache.some(r => r.name.toLowerCase() === 'aspiring dev');
    if (!hasAspiringDev) return false;

    // Filter out @everyone, Aspiring dev, reaction roles, and the command's filter role
    const unrecognizedRoles = member.roles.cache.filter(role => {
        if (role.id === member.guild.id) return false; 
        if (role.name.toLowerCase() === 'aspiring dev') return false;
        if (REACTION_ROLES.has(role.name.toLowerCase())) return false;
        if (allowedExtraRoleIds.includes(role.id)) return false; 
        return true; // Has some other role like Admin, Respected, etc.
    });
    
    // If they have ANY role other than Aspiring Dev, reaction roles, and the allowed filter role, we don't touch them.
    return unrecognizedRoles.size === 0;
}

const SAFETY_FAIL_MSG = '❌ **Protection Triggered:** I can only target users with *just* the "Aspiring dev" role. This keeps things safe during testing.';
// ---------------------

client.once('ready', async () => {
    console.log(`Logged in as ${client.user.tag}!`);
    console.log(`Whitelisted servers: ${[...ALLOWED_GUILDS].join(', ')}`);
    console.log('Registering slash commands...');

    client.user.setPresence({
        activities: [{ name: 'THE DEVCALL$ REVOLUTION', type: ActivityType.Watching }],
        status: 'online'
    });
    
    try {
        await client.application.commands.set(commandDefinitions);
        console.log('Successfully registered global slash commands.');
    } catch (error) {
        console.error('Failed to register slash commands:', error);
    }

    // Auto-leave any unauthorized servers the bot is already in
    for (const [id, guild] of client.guilds.cache) {
        if (!ALLOWED_GUILDS.has(id)) {
            console.log(`[SECURITY] Leaving unauthorized server: ${guild.name} (${id})`);
            await guild.leave().catch(() => {});
        }
    }
});

// Auto-leave if added to an unauthorized server
client.on('guildCreate', async guild => {
    if (!ALLOWED_GUILDS.has(guild.id)) {
        console.log(`[SECURITY] Blocked join attempt — leaving ${guild.name} (${guild.id})`);
        await guild.leave().catch(() => {});
    }
});

client.on('interactionCreate', async interaction => {
    // Block DMs entirely
    if (!interaction.guildId) {
        return interaction.reply({ content: 'This bot only works in authorized servers.', ephemeral: true }).catch(() => {});
    }

    // Block all interactions from unauthorized servers
    if (!ALLOWED_GUILDS.has(interaction.guildId)) {
        return interaction.reply({ content: 'This bot is not authorized for this server.', ephemeral: true }).catch(() => {});
    }

    if (interaction.isButton() && interaction.customId.startsWith('intel_')) {
        return intel.handleIntelButton(interaction);
    }

    if (!interaction.isChatInputCommand()) return;

    const { commandName, options, member, guild, channel } = interaction;
    const isOwner = interaction.user.id === OWNER_ID;

    // --- Lockdown/Unlock (owner-only) ---
    if (commandName === 'lockdown') {
        if (!isOwner) return interaction.reply({ content: '🚫 Only the bot owner can do this.', ephemeral: true });
        isLocked = true;
        return interaction.reply('🔒 **Lockdown active.** All commands are now restricted to the owner.');
    }
    if (commandName === 'unlockdown') {
        if (!isOwner) return interaction.reply({ content: '🚫 Only the bot owner can do this.', ephemeral: true });
        isLocked = false;
        return interaction.reply('🔓 **Lockdown lifted.** Commands are open again.');
    }

    // --- If locked, only the owner can use anything ---
    if (isLocked && !isOwner) {
        return interaction.reply({ content: '🔒 **Bot is in lockdown mode.** Only the owner can use commands right now.', ephemeral: true });
    }

    // --- Execution Authorization Check ---
    const executor = await guild.members.fetch(interaction.user.id).catch(() => null);
    if (!executor) return;

    const isAuthorized = isOwner || executor.roles.cache.some(role => {
        const rName = role.name.toLowerCase();
        return rName === 'staff' || rName === 'admin';
    });

    if (!isAuthorized && commandName !== 'intel') {
        return interaction.reply({ 
            content: '🚫 **Denied:** You need the `Staff` or `Admin` role to run these commands.', 
            ephemeral: true 
        });
    }
    // -------------------------------------

    try {
        if (commandName === 'ban') {
            const user = options.getUser('user');
            const targetMember = await guild.members.fetch(user.id).catch(() => null);
            if (!targetMember) return interaction.reply({ content: '❌ User not found in this server.', ephemeral: true });

            const reason = options.getString('reason') || 'No reason provided';
            await targetMember.ban({ reason });
            await interaction.reply(`🔨 Successfully banned \`${user.tag}\`. Reason: ${reason}`);
        }

        else if (commandName === 'unban') {
            // Unban doesn't check roles since they are banned
            const userId = options.getString('userid');
            await guild.members.unban(userId);
            await interaction.reply(`✅ Successfully unbanned user ID \`${userId}\`.`);
        }

        else if (commandName === 'kick') {
            const user = options.getUser('user');
            const targetMember = await guild.members.fetch(user.id).catch(() => null);
            if (!targetMember) return interaction.reply({ content: '❌ User not found in this server.', ephemeral: true });

            const reason = options.getString('reason') || 'No reason provided';
            await targetMember.kick(reason);
            await interaction.reply(`👢 Successfully kicked \`${user.tag}\`. Reason: ${reason}`);
        }

        else if (commandName === 'mute') {
            const user = options.getUser('user');
            const targetMember = await guild.members.fetch(user.id).catch(() => null);
            if (!targetMember) return interaction.reply({ content: '❌ User not found in this server.', ephemeral: true });

            const duration = options.getInteger('duration');
            const reason = options.getString('reason') || 'No reason provided';
            
            await targetMember.timeout(duration * 60 * 60 * 1000, reason);
            await interaction.reply(`🔇 Successfully muted \`${user.tag}\` for ${duration} hours. Reason: ${reason}`);
        }

        else if (commandName === 'unmute') {
            const user = options.getUser('user');
            const targetMember = await guild.members.fetch(user.id).catch(() => null);
            if (!targetMember) return interaction.reply({ content: '❌ User not found in this server.', ephemeral: true });

            await targetMember.timeout(null, 'Manual unmute');
            await interaction.reply(`🔊 Successfully unmuted \`${user.tag}\`.`);
        }

        else if (commandName === 'clear') {
            const amount = options.getInteger('amount');
            const user = options.getUser('user');
            
            if (amount < 1 || amount > 100) return interaction.reply({ content: 'Amount must be between 1 and 100.', ephemeral: true });
            
            // No protection check needed for clear filter

            await interaction.deferReply({ ephemeral: true });
            let messages = await channel.messages.fetch({ limit: amount });
            if (user) {
                messages = messages.filter(m => m.author.id === user.id);
            }
            
            await channel.bulkDelete(messages, true);
            await interaction.editReply(`🗑️ Cleared ${messages.size} messages.`);
        }

        else if (commandName === 'slowmode') {
            const seconds = options.getInteger('seconds');
            await channel.setRateLimitPerUser(seconds);
            await interaction.reply(`⏱️ Slowmode set to ${seconds} seconds.`);
        }

        else if (commandName === 'lock') {
            await channel.permissionOverwrites.edit(guild.roles.everyone, { SendMessages: false });
            await interaction.reply('🔒 Channel locked.');
        }

        else if (commandName === 'unlock') {
            await channel.permissionOverwrites.edit(guild.roles.everyone, { SendMessages: null });
            await interaction.reply('🔓 Channel unlocked.');
        }

        else if (commandName === 'warn') {
            const user = options.getUser('user');
            const reason = options.getString('reason');
            db.addWarning(user.id, reason);
            await interaction.reply(`⚠️ Warned \`${user.tag}\`: ${reason}`);
        }

        else if (commandName === 'warnings') {
            const user = options.getUser('user');
            const warnings = db.getWarnings(user.id);
            
            if (warnings.length === 0) return interaction.reply(`\`${user.tag}\` has 0 warnings.`);
            
            const warnText = warnings.map((w, i) => `${i + 1}. **${w.reason}** (<t:${Math.floor(new Date(w.date).getTime() / 1000)}:R>)`).join('\n');
            const embed = new EmbedBuilder().setTitle(`Warnings for ${user.tag}`).setDescription(warnText).setColor('#ffcc00');
            await interaction.reply({ embeds: [embed] });
        }

        else if (commandName === 'clearwarnings') {
            const user = options.getUser('user');
            db.clearWarnings(user.id);
            await interaction.reply(`🧹 Cleared all warnings for \`${user.tag}\`.`);
        }

        else if (commandName === 'userinfo') {
            const user = options.getUser('user');
            const targetMember = await guild.members.fetch(user.id);
            
            const embed = new EmbedBuilder()
                .setThumbnail(user.displayAvatarURL())
                .setTitle(`User Info: ${user.tag}`)
                .addFields(
                    { name: 'ID', value: user.id, inline: true },
                    { name: 'Joined Server', value: `<t:${Math.floor(targetMember.joinedTimestamp / 1000)}:R>`, inline: true },
                    { name: 'Account Created', value: `<t:${Math.floor(user.createdTimestamp / 1000)}:R>`, inline: true },
                    { name: 'Roles', value: targetMember.roles.cache.map(r => r).join(', ') || 'None' }
                );
            await interaction.reply({ embeds: [embed] });
        }

        else if (commandName === 'serverinfo') {
            const embed = new EmbedBuilder()
                .setThumbnail(guild.iconURL())
                .setTitle(`Server Info: ${guild.name}`)
                .addFields(
                    { name: 'ID', value: guild.id, inline: true },
                    { name: 'Members', value: `${guild.memberCount}`, inline: true },
                    { name: 'Created At', value: `<t:${Math.floor(guild.createdTimestamp / 1000)}:R>`, inline: true }
                );
            await interaction.reply({ embeds: [embed] });
        }

        else if (commandName === 'role') {
            const user = options.getUser('user');
            const targetMember = await guild.members.fetch(user.id).catch(() => null);
            if (!targetMember) return interaction.reply({ content: '❌ User not found in this server.', ephemeral: true });

            const action = options.getString('action');
            const role = options.getRole('role');

            if (action === 'add') {
                await targetMember.roles.add(role);
                await interaction.reply(`✅ Added role ${role.name} to \`${user.tag}\`.`);
            } else {
                await targetMember.roles.remove(role);
                await interaction.reply(`✅ Removed role ${role.name} from \`${user.tag}\`.`);
            }
        }

        // Bulk operations are expensive, defer reply
        else if (['roleall', 'bulkrole', 'bulkkick'].includes(commandName)) {
            await interaction.deferReply();
            await guild.members.fetch(); // Ensure cache is populated
            
            if (commandName === 'roleall') {
                const action = options.getString('action');
                const role = options.getRole('role');
                // MUST be targetable to be affected
                const members = guild.members.cache.filter(m => isTargetable(m));

                let count = 0;
                for (const [id, m] of members) {
                    try {
                        if (action === 'add' && !m.roles.cache.has(role.id)) {
                            await m.roles.add(role); count++;
                        } else if (action === 'remove' && m.roles.cache.has(role.id)) {
                            await m.roles.remove(role); count++;
                        }
                    } catch (e) { console.error(`Failed roleall on ${m.user.tag}`); }
                }
                await interaction.editReply(`✅ Successfully ${action === 'add' ? 'added' : 'removed'} ${role.name} for **${count}** Aspiring devs.`);
            }

            else if (commandName === 'bulkrole') {
                const action = options.getString('action');
                const targetRole = options.getRole('target_role');
                const filterRole = options.getRole('filter_role');
                // MUST have filter role AND be targetable allowing the filter role
                const members = guild.members.cache.filter(m => m.roles.cache.has(filterRole.id) && isTargetable(m, [filterRole.id]));

                let count = 0;
                for (const [id, m] of members) {
                    try {
                        if (action === 'add' && !m.roles.cache.has(targetRole.id)) {
                            await m.roles.add(targetRole); count++;
                        } else if (action === 'remove' && m.roles.cache.has(targetRole.id)) {
                            await m.roles.remove(targetRole); count++;
                        }
                    } catch (e) { console.error(`Failed bulkrole on ${m.user.tag}`); }
                }
                await interaction.editReply(`✅ Successfully ${action === 'add' ? 'added' : 'removed'} ${targetRole.name} for **${count}** Aspiring devs who had ${filterRole.name}.`);
            }

            else if (commandName === 'bulkkick') {
                const filterRole = options.getRole('filter_role');
                // MUST have filter role AND be targetable allowing the filter role
                const members = guild.members.cache.filter(m => m.roles.cache.has(filterRole.id) && isTargetable(m, [filterRole.id]));

                let count = 0;
                for (const [id, m] of members) {
                    try {
                        await m.kick(`Bulk kick requested by ${interaction.user.tag}`);
                        count++;
                    } catch (e) { console.error(`Failed bulkkick on ${m.user.tag}`); }
                }
                await interaction.editReply(`👢 Successfully kicked **${count}** Aspiring devs who had the ${filterRole.name} role.`);
            }
        }

        else if (commandName === 'intel') {
            return intel.handleIntelCommand(interaction);
        }
    } catch (error) {
        console.error(error);
        const errObj = { content: 'There was an error executing this command! (Check console for details)', ephemeral: true };
        if (interaction.deferred || interaction.replied) {
            await interaction.followUp(errObj);
        } else {
            await interaction.reply(errObj);
        }
    }
});

client.login(process.env.DISCORD_TOKEN);
