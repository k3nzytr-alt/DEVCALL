const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');

module.exports = [
    // Standard Moderation
    new SlashCommandBuilder()
        .setName('ban')
        .setDescription('Ban a user from the server')
        .addUserOption(option => option.setName('user').setDescription('The user to ban').setRequired(true))
        .addStringOption(option => option.setName('reason').setDescription('Reason for the ban').setRequired(false))
        .setDefaultMemberPermissions(PermissionFlagsBits.BanMembers),

    new SlashCommandBuilder()
        .setName('unban')
        .setDescription('Unban a user by their ID')
        .addStringOption(option => option.setName('userid').setDescription('The ID of the user to unban').setRequired(true))
        .setDefaultMemberPermissions(PermissionFlagsBits.BanMembers),

    new SlashCommandBuilder()
        .setName('kick')
        .setDescription('Kick a user from the server')
        .addUserOption(option => option.setName('user').setDescription('The user to kick').setRequired(true))
        .addStringOption(option => option.setName('reason').setDescription('Reason for the kick').setRequired(false))
        .setDefaultMemberPermissions(PermissionFlagsBits.KickMembers),

    new SlashCommandBuilder()
        .setName('mute')
        .setDescription('Mute (timeout) a user')
        .addUserOption(option => option.setName('user').setDescription('The user to mute').setRequired(true))
        .addIntegerOption(option => option.setName('duration').setDescription('Duration in hours').setRequired(true))
        .addStringOption(option => option.setName('reason').setDescription('Reason for the mute').setRequired(false))
        .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers),

    new SlashCommandBuilder()
        .setName('unmute')
        .setDescription('Unmute (remove timeout) a user')
        .addUserOption(option => option.setName('user').setDescription('The user to unmute').setRequired(true))
        .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers),

    new SlashCommandBuilder()
        .setName('clear')
        .setDescription('Clear messages from the current channel')
        .addIntegerOption(option => option.setName('amount').setDescription('Number of messages to delete (1-100)').setRequired(true))
        .addUserOption(option => option.setName('user').setDescription('Filter by user (optional)').setRequired(false))
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages),

    new SlashCommandBuilder()
        .setName('slowmode')
        .setDescription('Set slowmode for the current channel')
        .addIntegerOption(option => option.setName('seconds').setDescription('Slowmode duration in seconds (0 to disable)').setRequired(true))
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels),

    new SlashCommandBuilder()
        .setName('lock')
        .setDescription('Lock the current channel')
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels),

    new SlashCommandBuilder()
        .setName('unlock')
        .setDescription('Unlock the current channel')
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels),

    // Info & Logs
    new SlashCommandBuilder()
        .setName('warn')
        .setDescription('Warn a user')
        .addUserOption(option => option.setName('user').setDescription('The user to warn').setRequired(true))
        .addStringOption(option => option.setName('reason').setDescription('Reason for the warning').setRequired(true))
        .setDefaultMemberPermissions(PermissionFlagsBits.KickMembers),

    new SlashCommandBuilder()
        .setName('warnings')
        .setDescription('Check warnings for a user')
        .addUserOption(option => option.setName('user').setDescription('The user to check').setRequired(true))
        .setDefaultMemberPermissions(PermissionFlagsBits.KickMembers),

    new SlashCommandBuilder()
        .setName('clearwarnings')
        .setDescription('Clear warnings for a user')
        .addUserOption(option => option.setName('user').setDescription('The user to clear').setRequired(true))
        .setDefaultMemberPermissions(PermissionFlagsBits.KickMembers),

    new SlashCommandBuilder()
        .setName('userinfo')
        .setDescription('Get information about a user')
        .addUserOption(option => option.setName('user').setDescription('The user').setRequired(true)),

    new SlashCommandBuilder()
        .setName('serverinfo')
        .setDescription('Get information about the server'),

    // Bulk Management
    new SlashCommandBuilder()
        .setName('role')
        .setDescription('Add or remove a role from a specific user')
        .addUserOption(option => option.setName('user').setDescription('The user').setRequired(true))
        .addStringOption(option => option.setName('action').setDescription('Add or Remove').setRequired(true).addChoices({ name: 'Add', value: 'add' }, { name: 'Remove', value: 'remove' }))
        .addRoleOption(option => option.setName('role').setDescription('The role').setRequired(true))
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageRoles),

    new SlashCommandBuilder()
        .setName('roleall')
        .setDescription('Add or remove a role from ALL members')
        .addStringOption(option => option.setName('action').setDescription('Add or Remove').setRequired(true).addChoices({ name: 'Add', value: 'add' }, { name: 'Remove', value: 'remove' }))
        .addRoleOption(option => option.setName('role').setDescription('The role').setRequired(true))
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

    new SlashCommandBuilder()
        .setName('bulkrole')
        .setDescription('Give/remove a target role to everyone who has a specific filter role')
        .addStringOption(option => option.setName('action').setDescription('Add or Remove').setRequired(true).addChoices({ name: 'Add', value: 'add' }, { name: 'Remove', value: 'remove' }))
        .addRoleOption(option => option.setName('target_role').setDescription('The role to give/remove').setRequired(true))
        .addRoleOption(option => option.setName('filter_role').setDescription('The role required to be affected').setRequired(true))
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

    new SlashCommandBuilder()
        .setName('bulkkick')
        .setDescription('Kick everyone who has a specific role')
        .addRoleOption(option => option.setName('filter_role').setDescription('The role required to be kicked').setRequired(true))
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

    // Public API Commands
    new SlashCommandBuilder()
        .setName('intel')
        .setDescription('Interactive dashboard for Roblox game metrics, monetization, and retention.')
        .addStringOption(option => option.setName('game').setDescription('Game Link or Place ID').setRequired(true)),

    // Owner-Only
    new SlashCommandBuilder()
        .setName('lockdown')
        .setDescription('Lock down the bot — only the owner can use commands.')
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

    new SlashCommandBuilder()
        .setName('unlockdown')
        .setDescription('Lift lockdown — restore normal command access.')
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
];
