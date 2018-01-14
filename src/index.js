
const apiai = require('apiai');
const process = require('process');
const readline = require('readline');
const relay = require('librelay');

const aiApp = apiai(process.env.API_AI_TOKEN);

async function aiRequest(textQuery, sessionId) {
    return await new Promise((resolve, reject) => {
        const req = aiApp.textRequest(textQuery, {sessionId});
        req.on('response', x => resolve(x.result));
        req.on('error', reject);
        req.end();
    });
}

async function input(prompt) {
    const rl = readline.createInterface(process.stdin, process.stdout);
    try {
        return await new Promise(resolve => rl.question(prompt, resolve));
    } finally {
        rl.close();
    }
}

async function login(userTag) {
    if (!userTag) {
        userTag = await input("Enter your full user tag (e.g @user:org): ");
    }
    const completeLogin = await relay.AtlasClient.authenticate(userTag);
    await completeLogin(await input("SMS Verification Code: "));
}

async function main() {
    if (!await relay.storage.getState('atlasCredential')) {
        await login();
    }
    let atlas;
    try {
        atlas = await relay.AtlasClient.factory();
    } catch(e) {
        console.error("Failed to get atlas client:", e);
        await login();
        return await main();
    }
    if (!await relay.storage.getState('registrationId')) {
        const devices = await atlas.getDevices();
        if (devices.length) {
            console.log('Confirm you want to replace existing devices...');
            for (const x of devices) {
                console.log('   ', x.id, x.name);
            }
            if (await input('"YES" to reset account: ') !== 'YES') {
                process.exit(1);
            }
        }
        await relay.registerAccount();
    }
    const botAddr = await relay.storage.getState('addr');
    const bot = (await atlas.getUsers([botAddr]))[0];
    console.info(`Starting message listener for: @${bot.tag.slug}:${bot.org.slug}`);
    atlas.maintainToken(true);
    msgListener({atlas, bot});
}

async function msgListener({atlas, bot}) {
    const msgRecv = await relay.MessageReceiver.factory();
    const msgSend = await relay.MessageSender.factory();
    const distCache = new Map();
    const state = {atlas, bot};
    const intentManager = new IntentManager(state);
    const needsResponse = (sender, dist, text) => {
        const members = new Set(dist.userids);
        members.delete(bot.id);
        members.delete(sender);
        if (members.size === 0) {
            return true;  // DM
        }
        if (text.match(new RegExp(state.bot.first_name, 'i')) ||
            text.match(new RegExp(state.bot.last_name, 'i')) ||
            text.match(new RegExp(state.bot.tag.slug, 'i'))) {
            return true;
        }
    };
    msgRecv.addEventListener('message', async ev => {
        const msg = JSON.parse(ev.data.message.body)[0];
        let text;
        if (msg.data.body) {
            for (const x of msg.data.body) {
                if (x.type === 'text/plain') {
                    text = x.value;
                    break;
                }
            }
        }
        if (!text) {
            console.info("Empty message (no text)");
            return;
        }
        const distExpr = msg.distribution.expression;
        if (!distCache.has(distExpr)) {
            distCache.set(distExpr, await atlas.resolveTags(distExpr));
        }
        const distribution = distCache.get(distExpr);
        if (!needsResponse(ev.data.source, distribution, text)) {
            console.info("Ignoring message not for me:", text);
            return;
        }
        const aiResp = await aiRequest(text, msg.threadId);
        const intentHandler = intentManager.findHandler(aiResp.action);
        const respMsg = {
            distribution,
            threadId: msg.threadId,
            text: aiResp.fulfillment.speech
        };
        if (intentHandler) {
            try {
                const res = await intentHandler(aiResp.parameters);
                if (typeof res === 'string') {
                    respMsg.text = res;
                } else {
                    Object.assign(respMsg, res);
                }
            } catch(e) {
                console.error("Intent Handler Error:", e);
                respMsg.text = `Affraid I can't do that boss...\n(${e})`;
                respMsg.html = `Affraid I can't do that boss...<br/><pre>${e}</pre>`;
            }
        }
        if (!respMsg.text) {
            respMsg.text = `I have nothing to do with: "${aiResp.action}"`;
        }
        await msgSend.send(respMsg);
    });
    msgRecv.addEventListener('keychange', async ev => {
        console.warn("Auto-accepting new identity key(recv):", ev.keyError.addr);
        await ev.accept();
    });
    msgSend.addEventListener('keychange', async ev => {
        console.warn("Auto-accepting new identity key(send):", ev.keyError.addr);
        await ev.accept();
    });
    await msgRecv.connect();
}


class IntentManager {

    constructor(state) {
        this.state = state;
        this.handlers = new Map();
        for (const prop of Object.getOwnPropertyNames(Object.getPrototypeOf(this))) {
            if (prop.startsWith('handle')) {
                // convert CaseStyleName to case.style.name
                const name = prop.replace(/([A-Z])/g, x => '.' + x.toLowerCase()).substr(7);
                this.handlers.set(name, this[prop].bind(this));
            }
        }
    }

    async updateBotUser(updates) {
        const bot = await this.state.atlas.fetch(`/v1/user/${this.state.bot.id}/`, {
            method: 'PATCH',
            json: updates
        });
        this.state.bot = bot;
        return bot;
    }

    async updateBotTag(updates) {
        const tag = await this.state.atlas.fetch(`/v1/tag/${this.state.bot.tag.id}/`, {
            method: 'PATCH',
            json: updates
        });
        this.state.bot.tag = tag;
        return tag;
    }

    handleNameAgentGet(params) {
        const bot = this.state.bot;
        if (params.type) {
            if (params.type === 'first name') {
                return bot.first_name || "I don't have a first name.";
            } else if (params.type === 'last name') {
                return bot.last_name || "I don't have a last name.";
            } else if (params.type === 'middle name') {
                return bot.middle_name || "I don't have a middle name.";
            } else if (params.type === 'tag') {
                return '@' + bot.tag.slug + ':' + bot.org.slug;
            }
        } else {
            const chance = Math.random();
            if (chance < 0.33) {
                return 'You can call me ' + bot.first_name;
            } else if (chance < 0.66) {
                return 'You are speaking with ' + bot.first_name + ' ' + bot.last_name;
            } else {
                return 'My tag is @' + bot.tag.slug + ':' + bot.org.slug;
            }
        }
    }

    async handleNameAgentChange(params) {
        const updates = {};
        console.info("Name change request:", params);
        if (params.type) {
            if (params.type === 'first name') {
                updates.first_name = params.name;
            } else if (params.type === 'last name') {
                updates.last_name = params.name;
            } else if (params.type === 'middle name') {
                updates.middle_name = params.name;
            } else if (params.type === 'tag') {
                const slug = params.name.replace(/\s+/g, '.').toLowerCase();
                const tag = await this.updateBotTag({slug});
                return `Okay, my tag is now @${tag.slug}:${this.state.bot.org.slug}`;
            } else {
                console.warn("Unhandled name type:", params.type);
            }
        } else if (params.name) {
            const names = params.name.split(/\s+/, 3);
            updates.first_name = names[0];
            if (names.length === 2) {
                updates.last_name = names[1];
            } else if (names.length === 3) {
                updates.middle_name = names[1];
                updates.last_name = names[2];
            }
        } else {
            return 'To what?';
        }
        const bot = await this.updateBotUser(updates);
        return `Okay, I'm now ${bot.first_name} ${bot.middle_name} ${bot.last_name}`;
    }

    async handleNameAgentDelete(params) {
        if (!params.type) {
            return 'I can\'t delete my whole name silly.';
        }
        const updates = {};
        if (params.type === 'first name') {
            return 'I must have a first name!';
        } else if (params.type === 'last name') {
            return 'I must have a last name!';
        } else if (params.type === 'middle name') {
            updates.middle_name = '';
        } else if (params.type === 'tag') {
            return 'I must have a tag!';
        } else {
            console.warn("Unhandled name type:", params.type);
        }
        const bot = await this.updateBotUser(updates);
        return `Okay, I'm now ${bot.first_name} ${bot.middle_name} ${bot.last_name}`;
    }

    findHandler(name) {
        const handler = this.handlers.get(name);
        if (handler) {
            console.debug('Using Handler:', handler);
        } else {
            console.warn('No handler for:', name);
        }
        return handler;
    }
}


main().catch(e => console.error(e));
