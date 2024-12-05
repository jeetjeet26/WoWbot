const { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder } = require('discord.js');
const { OpenAI } = require("openai");
const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const { DynamoDBDocumentClient, GetCommand, PutCommand, DeleteCommand } = require("@aws-sdk/lib-dynamodb");
require("dotenv").config();

// Initialize DynamoDB client
const dynamoClient = new DynamoDBClient({
    region: process.env.AWS_REGION,
    credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
    }
});

const docClient = DynamoDBDocumentClient.from(dynamoClient);

const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY
});

// Discord Client setup
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildVoiceStates
    ]
});

// Setup slash commands
const commands = [
    new SlashCommandBuilder()
        .setName('join')
        .setDescription('Join WoWBot to this text channel'),
    new SlashCommandBuilder()
        .setName('leave')
        .setDescription('Remove WoWBot from this text channel')
];

// Register slash commands
const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);

(async () => {
    try {
        console.log('Started refreshing application (/) commands.');

        await rest.put(
            Routes.applicationCommands(process.env.CLIENT_ID),
            { body: commands },
        );

        console.log('Successfully reloaded application (/) commands.');
    } catch (error) {
        console.error('Error refreshing commands:', error);
    }
})();

const sleep = (ms) => {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// DynamoDB functions to replace in-memory storage
const getOpenAiThreadId = async (discordThreadId, guildId) => {
    try {
        const command = new GetCommand({
            TableName: "DiscordOpenAIThreads",
            Key: {
                discordThreadId: discordThreadId,
                guildId: guildId
            }
        });
        
        const response = await docClient.send(command);
        return response.Item?.openAiThreadId;
    } catch (error) {
        console.error('Error fetching thread from DynamoDB:', error);
        return null;
    }
}

const addThreadToMap = async (discordThreadId, openAiThreadId, guildId) => {
    try {
        const command = new PutCommand({
            TableName: "DiscordOpenAIThreads",
            Item: {
                discordThreadId: discordThreadId,
                guildId: guildId,
                openAiThreadId: openAiThreadId,
                createdAt: new Date().toISOString()
            }
        });
        
        await docClient.send(command);
    } catch (error) {
        console.error('Error saving thread to DynamoDB:', error);
        throw error;
    }
}

const removeThreadFromMap = async (discordThreadId, guildId) => {
    try {
        const command = new DeleteCommand({
            TableName: "DiscordOpenAIThreads",
            Key: {
                guildId: guildId,
                discordThreadId: discordThreadId
            }
        });
        await docClient.send(command);
    } catch (error) {
        console.error('Error deleting thread from DynamoDB:', error);
        throw error;
    }
}

const terminalStates = ["cancelled", "failed", "completed", "expired"];
const statusCheckLoop = async (openAiThreadId, runId) => {
    const run = await openai.beta.threads.runs.retrieve(
        openAiThreadId,
        runId
    );

    if(terminalStates.indexOf(run.status) < 0){
        await sleep(1000);
        return statusCheckLoop(openAiThreadId, runId);
    }
    return run.status;
}

const addMessage = (threadId, content) => {
    return openai.beta.threads.messages.create(
        threadId,
        { role: "user", content }
    )
}

// Handle slash commands
client.on('interactionCreate', async interaction => {
    if (!interaction.isChatInputCommand()) return;

    if (interaction.commandName === 'join') {
        try {
            // Add the channel to tracking
            const thread = await openai.beta.threads.create();
            await addThreadToMap(interaction.channelId, thread.id, interaction.guildId);
            await interaction.reply('WoWBot is now active in this channel! I will respond to messages here.');
        } catch (error) {
            console.error('Error joining channel:', error);
            await interaction.reply('Failed to join the channel.');
        }
    }

    if (interaction.commandName === 'leave') {
        try {
            await removeThreadFromMap(interaction.channelId, interaction.guildId);
            await interaction.reply('WoWBot has left this channel. Use /join to reactivate me here.');
        } catch (error) {
            console.error('Error leaving channel:', error);
            await interaction.reply('Failed to leave the channel.');
        }
    }
});

// Message handling
client.on('messageCreate', async message => {
    if (message.author.bot || !message.content || message.content === '') return;
    
    const discordThreadId = message.channel.id;
    let openAiThreadId = await getOpenAiThreadId(discordThreadId, message.guildId);

    // Only respond if we have an OpenAI thread ID for this channel
    if (!openAiThreadId) {
        return; // Don't respond in channels where the bot hasn't been invited
    }

    let messagesLoaded = false;
    if(message.channel.isThread()){
        const starterMsg = await message.channel.fetchStarterMessage();
        const otherMessagesRaw = await message.channel.messages.fetch();

        const otherMessages = Array.from(otherMessagesRaw.values())
            .map(msg => msg.content)
            .reverse();

        const messages = [starterMsg.content, ...otherMessages]
            .filter(msg => !!msg && msg !== '')

        await Promise.all(messages.map(msg => addMessage(openAiThreadId, msg)));
        messagesLoaded = true;
    }

    if(!messagesLoaded){
        await addMessage(openAiThreadId, message.content);
    }

    const run = await openai.beta.threads.runs.create(
        openAiThreadId,
        { assistant_id: process.env.ASSISTANT_ID }
    )
    const status = await statusCheckLoop(openAiThreadId, run.id);

    const messages = await openai.beta.threads.messages.list(openAiThreadId);
    let response = messages.data[0].content[0].text.value;
    response = response.substring(0, 1999);

    console.log(response);
    message.reply(response);
});

client.once('ready', () => {
    console.log('Bot is ready!');
});

client.login(process.env.DISCORD_TOKEN);