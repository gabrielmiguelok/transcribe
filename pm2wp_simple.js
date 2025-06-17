/**
 * ---------------------------------------------------------
 * Script de Monitoreo y Procesamiento de Transcripciones .txt
 * Mejora implementada:
 *   1) Soporta múltiples sesiones automáticamente (directorios en ./auth).
 *   2) Si existen varias sesiones, se monitorea con TODAS a la vez.
 *   3) TODOS los historiales se consolidan en **una única** colección MongoDB,
 *      comportándose como si fuesen un solo cliente.
 *   4) Toda la lógica previa se preserva; solo se amplía donde es necesario.
 * ---------------------------------------------------------
 */

const DEBUG_MODE   = true;
const MONGO_URI    = 'mongodb://localhost:27017';
const SESSION_NAME = 'gabriel2';               // Sesión primaria (fallback)
const COLLECTION_NAME = 'gabriel';            // Colección ÚNICA combinada
const MY_NUMBER    = '5492364655702';         // <--- Tu número personal
const FORCE_TARGET_NUMBER = '5492364655702';  // Se deja definido pero no se usa

// ---------------------------------------------------------------------
// DEPENDENCIAS
// ---------------------------------------------------------------------
const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    downloadMediaMessage,
} = require('@whiskeysockets/baileys');

const qrcode       = require('qrcode-terminal');
const { Boom }     = require('@hapi/boom');
const path         = require('path');
const pino         = require('pino');
const fs           = require('fs');
const { createLogger, format, transports } = require('winston');
const { MongoClient } = require('mongodb');

// ---------------------------------------------------------------------
// LOGGING
// ---------------------------------------------------------------------
const logger = createLogger({
    level: 'debug',
    format: format.combine(
        format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
        format.printf(({ timestamp, level, message }) => `[${timestamp}] ${level.toUpperCase()}: ${message}`)
    ),
    transports: [
        new transports.File({ filename: 'application.log' }),
        new transports.Console()
    ]
});

// ---------------------------------------------------------------------
// UTILIDADES
// ---------------------------------------------------------------------
function isMediaMessage(msg) {
    return (
        msg.imageMessage   ||
        msg.videoMessage   ||
        msg.audioMessage   ||
        msg.documentMessage||
        msg.stickerMessage
    );
}

function getMediaTypeAndExtension(message) {
    if (message.imageMessage)  return { type: 'image',    extension: 'jpg'  };
    if (message.videoMessage)  return { type: 'video',    extension: 'mp4'  };
    if (message.audioMessage) {
        const mime = message.audioMessage.mimetype || '';
        if (mime.includes('ogg')) return { type: 'audio', extension: 'ogg'  };
        if (mime.includes('mp3')) return { type: 'audio', extension: 'mp3'  };
        return { type: 'audio', extension: 'opus' };
    }
    if (message.documentMessage) {
        const mime = message.documentMessage.mimetype || '';
        if (mime.includes('pdf'))   return { type: 'document', extension: 'pdf'  };
        if (mime.includes('word'))  return { type: 'document', extension: 'docx' };
        if (mime.includes('sheet')) return { type: 'document', extension: 'xlsx' };
        if (mime.includes('ppt'))   return { type: 'document', extension: 'pptx' };
        if (mime.includes('zip'))   return { type: 'document', extension: 'zip'  };
        return { type: 'document', extension: 'bin' };
    }
    if (message.stickerMessage) return { type: 'sticker', extension: 'webp' };
    return null;
}

// ---------------------------------------------------------------------
// INTERFAZ DE WHATSAPP CLIENT
// ---------------------------------------------------------------------
class IWhatsAppClient {
    initialize()                {}
    setMessageHandler(handler)  {}
    sendMessage(to, message)    {}
    getClientInfo()             {}
}

// ---------------------------------------------------------------------
// IMPLEMENTACIÓN BAILEYS
// ---------------------------------------------------------------------
class WhatsAppClient extends IWhatsAppClient {
    constructor(sessionName) {
        super();
        this.sessionName      = sessionName;
        this.onMessageReceived= null;
        this.sock             = null;
        this.initialized      = false;
        this.authFolder       = path.join(__dirname, 'auth', this.sessionName);
    }

    async initialize() {
        if (!fs.existsSync(this.authFolder)) {
            fs.mkdirSync(this.authFolder, { recursive: true });
        }

        const { state, saveCreds } = await useMultiFileAuthState(this.authFolder);
        this.sock = makeWASocket({
            auth: state,
            logger: pino({ level: 'error' }),
            printQRInTerminal: false
        });

        this.sock.ev.on('connection.update', (update) => {
            const { connection, lastDisconnect, qr } = update;
            if (qr) {
                console.clear();
                console.log(`\n[Sesión: ${this.sessionName}] Escanea el siguiente código QR:\n`);
                qrcode.generate(qr, { small: true });
            }

            if (connection === 'close') {
                const isBoom         = lastDisconnect?.error instanceof Boom;
                const statusCode     = isBoom ? lastDisconnect.error.output.statusCode : null;
                const shouldReconnect= statusCode !== DisconnectReason.loggedOut;

                console.error(`[Sesión: ${this.sessionName}] Conexión cerrada. Reintentando en 5s...`, shouldReconnect);
                logger.warn(`Sesión ${this.sessionName} desconectada. Reconexión: ${shouldReconnect}`);

                if (shouldReconnect) {
                    setTimeout(() => this.initialize(), 5000);
                } else {
                    console.log(`[Sesión: ${this.sessionName}] Sesión cerrada definitivamente. Elimina la carpeta "auth/${this.sessionName}" para volver a conectar.`);
                }
            } else if (connection === 'open') {
                console.log(`[Sesión: ${this.sessionName}] Conectado exitosamente.`);
                logger.info(`Sesión ${this.sessionName} conectada.`);
                this.initialized = true;
            }
        });

        this.sock.ev.on('messages.upsert', async (m) => {
            const messages = m.messages;
            for (const message of messages) {
                if (!message.message) continue;

                const sender = message.key.remoteJid || '';
                if (!sender.endsWith('@s.whatsapp.net') && !sender.endsWith('@g.us')) continue;

                if (DEBUG_MODE) {
                    console.log(`[DEBUG] [${this.sessionName}] Mensaje entrante:\n`, JSON.stringify(message, null, 2));
                }

                if (this.onMessageReceived) {
                    this.onMessageReceived(
                        { fullMessage: message, from: sender },
                        this.sessionName,
                        this                       // <-- Referencia al cliente
                    );
                }
            }
        });

        this.sock.ev.on('creds.update', saveCreds);
    }

    setMessageHandler(handler) {
        this.onMessageReceived = handler;
    }

    async sendMessage(to, message) {
        const jid = to.includes('@') ? to : `${to}@s.whatsapp.net`;
        try {
            await this.sock.sendMessage(jid, { text: message });
            logger.info(`Mensaje enviado a ${to} desde la sesión ${this.sessionName}.`);
        } catch (error) {
            console.error(`Error al enviar mensaje a ${to}: ${error.message}`);
            logger.error(`Error al enviar mensaje a ${to} desde la sesión ${this.sessionName}: ${error.message}`);
        }
    }

    getClientInfo() {
        if (this.sock?.user?.id) {
            const userId = this.sock.user.id.split('@')[0];
            return { wid: { user: userId } };
        }
        return { wid: { user: null } };
    }
}

// ---------------------------------------------------------------------
// FÁBRICA DE CLIENTES
// ---------------------------------------------------------------------
class WhatsAppClientFactory {
    createClient(sessionName) {
        return new WhatsAppClient(sessionName);
    }
}

// ---------------------------------------------------------------------
// ADMINISTRADOR DE CLIENTES (MULTI-SESIÓN)
// ---------------------------------------------------------------------
class WhatsAppClientManager {
    constructor(clientFactory) {
        this.clientFactory      = clientFactory;
        this.clients            = new Map();   // sessionName => client
        this.primarySessionName = null;
    }

    async initializeClient(sessionName) {
        const client = this.clientFactory.createClient(sessionName);
        await client.initialize();
        await this.waitForClientReady(client);

        this.clients.set(sessionName, client);
        if (!this.primarySessionName) this.primarySessionName = sessionName;
    }

    waitForClientReady(client) {
        return new Promise(resolve => {
            const check = () => client.initialized ? resolve() : setTimeout(check, 500);
            check();
        });
    }

    /**
     * Si se pasa sessionName devuelve ese cliente,
     * si no, devuelve el cliente primario.
     */
    getClient(sessionName = null) {
        if (sessionName) return this.clients.get(sessionName) || null;
        return this.clients.get(this.primarySessionName) || null;
    }

    getAllClients() {
        return Array.from(this.clients.values());
    }
}

// ---------------------------------------------------------------------
// CONVERSACIONES EN MEMORIA (OPCIONAL)
// ---------------------------------------------------------------------
class Conversation {
    constructor(id, sessionName, clientNumber, recipientNumber) {
        this.id              = id;
        this.sessionName     = sessionName;
        this.clientNumber    = clientNumber;
        this.recipientNumber = recipientNumber;
        this.messages        = [];
    }
    addMessage(direction, content) { this.messages.push({ direction, content }); }
    display() {
        console.log(`\n-----------------`);
        console.log(`Conversación ID: ${this.id} (Sesión: ${this.sessionName}, Cuenta: ${this.clientNumber}, Receptora: ${this.recipientNumber})`);
        this.messages.forEach(msg => console.log(`${msg.direction}: ${msg.content}`));
        console.log('-----------------\n');
    }
}
class ConversationManager {
    constructor() { this.conversations = new Map(); this.counter = 1; }
    getConversation(sessionName, number, clientNumber) {
        const key = `${sessionName}-${number}`;
        if (!this.conversations.has(key)) {
            const convo = new Conversation(this.counter++, sessionName, clientNumber, number);
            this.conversations.set(key, convo);
        }
        return this.conversations.get(key);
    }
}

// ---------------------------------------------------------------------
// SERVICIO MONGO
// ---------------------------------------------------------------------
class MongoDBService {
    constructor(uri) { this.uri = uri; this.client = null; this.db = null; }

    async connect()            { this.client = new MongoClient(this.uri); await this.client.connect(); return this.client; }
    async close()              { if (this.client) await this.client.close(); }
    async selectDatabase()     { this.db = this.client.db('whatsapp'); console.log(`Base de datos seleccionada: whatsapp`); return this.db; }
    getCollection(name)        { return this.db.collection(name); }

    async updateDocAfterSend(collection, contactNumber, message, myNumber) {
        await collection.updateOne(
            { _id: contactNumber },
            { $push: {
                messages: {
                    direction : 'Enviado',
                    content   : message,
                    timestamp : new Date(),
                    sender    : myNumber,
                    recipient : contactNumber
                }
            }},
            { upsert: true }
        );
    }

    async updateDocAfterReceive(collection, contactNumber, message, myNumber) {
        await collection.updateOne(
            { _id: contactNumber },
            { $push: {
                messages: {
                    direction : 'Recibido',
                    content   : message,
                    timestamp : new Date(),
                    sender    : contactNumber,
                    recipient : myNumber
                }
            }},
            { upsert: true }
        );
    }
}

// ---------------------------------------------------------------------
// SERVICIO DE MENSAJES (ENVÍOS)
// ---------------------------------------------------------------------
class MessageService {
    constructor(client, conversationManager, mongoService, collection) {
        this.client              = client; // Cliente PRIMARIO
        this.conversationManager = conversationManager;
        this.mongoService        = mongoService;
        this.collection          = collection;
    }

    async sendMessageTo(contactNumber, message) {
        if (!this.client) {
            console.log('Cliente de WhatsApp no inicializado.');
            return;
        }
        const myNumber = this.client.getClientInfo().wid.user;

        await this.client.sendMessage(contactNumber, message);
        await this.mongoService.updateDocAfterSend(this.collection, contactNumber, message, myNumber);

        const convo = this.conversationManager.getConversation(this.client.sessionName, contactNumber, myNumber);
        convo.addMessage('Enviado', message);
        convo.display();
        logger.info(`Mensaje enviado a ${contactNumber} desde la sesión ${this.client.sessionName}.`);
    }
}

// ---------------------------------------------------------------------
// APLICACIÓN PRINCIPAL
// ---------------------------------------------------------------------
class Application {
    constructor() {
        this.clientFactory      = new WhatsAppClientFactory();
        this.clientManager      = new WhatsAppClientManager(this.clientFactory);
        this.conversationManager= new ConversationManager();
        this.mongoService       = new MongoDBService(MONGO_URI);

        this.collection         = null;
        this.messageService     = null;
        this.processedTranscriptions = new Set();

        // Enlazar this en callback
        this.handleIncomingMessage = this.handleIncomingMessage.bind(this);
    }

    async run() {
        try {
            // 1. Conexión a Mongo + DB
            await this.mongoService.connect();
            await this.mongoService.selectDatabase();

            // 2. Crear carpeta 'auth' si no existe
            const authDir = path.join(__dirname, 'auth');
            if (!fs.existsSync(authDir)) fs.mkdirSync(authDir);

            // 3. Detectar sesiones (directorios en /auth) o usar fallback
            let sessionNames = fs.readdirSync(authDir, { withFileTypes: true })
                                 .filter(dirent => dirent.isDirectory())
                                 .map(dirent => dirent.name);
            if (sessionNames.length === 0) sessionNames = [SESSION_NAME];

            // 4. Inicializar TODAS las sesiones detectadas
            for (const sName of sessionNames) {
                await this.clientManager.initializeClient(sName);
                const client = this.clientManager.getClient(sName);
                client.setMessageHandler(this.handleIncomingMessage);
            }

            // 5. Colección COMBINADA en Mongo
            this.collection = this.mongoService.getCollection(COLLECTION_NAME);

            // 6. Servicio de mensajes usando el cliente primario
            const primaryClient = this.clientManager.getClient();
            this.messageService = new MessageService(
                primaryClient,
                this.conversationManager,
                this.mongoService,
                this.collection
            );

            // 7. Iniciar chequeo de transcripciones cada 10s
            this.startTranscriptionChecker();

            console.log('Aplicación iniciada sin interfaz de consola. Monitoreo activo (multi-sesión)...');
            logger.info('Aplicación iniciada sin interfaz de consola. Monitoreo activo (multi-sesión)...');
        } catch (error) {
            console.error(`Error: ${error.message}`);
            logger.error(`Error en la aplicación: ${error.stack}`);
            process.exit(1);
        }
    }

    /**
     * Maneja los mensajes entrantes de CUALQUIER sesión de WhatsApp.
     */
    async handleIncomingMessage(msgContainer, sessionName, client) {
        try {
            if (!client) return;

            const myNumber   = client.getClientInfo().wid.user;
            let   rawContact = (msgContainer.from.split('@')[0] || '').split(':')[0];

            const fullMsg    = msgContainer.fullMessage;
            const fromMe     = fullMsg.key.fromMe;

            if (DEBUG_MODE) console.log(`[DEBUG] handleIncomingMessage -> session=${sessionName}, contact=${rawContact}, fromMe=${fromMe}`);

            const messageContent = fullMsg.message;
            if (!messageContent) {
                if (DEBUG_MODE) console.log('[DEBUG] No hay messageContent en el mensaje.');
                return;
            }

            const conversation = this.conversationManager.getConversation(sessionName, rawContact, myNumber);

            // ---------------------------------------------------------
            // A) Mensaje de Texto
            // ---------------------------------------------------------
            if (messageContent.conversation || messageContent.extendedTextMessage) {
                const text = messageContent.conversation
                          || (messageContent.extendedTextMessage?.text || '');

                if (!text.trim()) {
                    if (DEBUG_MODE) console.log('[DEBUG] Texto vacío, se ignora.');
                    return;
                }

                const direction = fromMe ? 'Enviado' : 'Recibido';
                if (fromMe) await this.mongoService.updateDocAfterSend   (this.collection, rawContact, text, myNumber);
                else        await this.mongoService.updateDocAfterReceive(this.collection, rawContact, text, myNumber);

                conversation.addMessage(direction, text);
                conversation.display();

                logger.info(`Mensaje de texto ${direction} => ${rawContact} en la sesión ${sessionName}.`);
                return;
            }

            // ---------------------------------------------------------
            // B) Mensaje Multimedia
            // ---------------------------------------------------------
            if (isMediaMessage(messageContent)) {
                const mediaTypeInfo = getMediaTypeAndExtension(messageContent);
                let   extension     = mediaTypeInfo?.extension || 'bin';
                let   typeLabel     = mediaTypeInfo?.type      || 'UNKNOWN';

                const finalFolder = path.join(__dirname, rawContact);
                if (!fs.existsSync(finalFolder)) {
                    fs.mkdirSync(finalFolder, { recursive: true });
                    if (DEBUG_MODE) console.log(`[DEBUG] Se creó carpeta: ${finalFolder}`);
                }

                const buffer = await downloadMediaMessage(
                    fullMsg,
                    'buffer',
                    {},
                    { logger: pino({ level: 'silent' }) }
                );

                const fileMatchPattern = new RegExp(`^${rawContact}_(?:send|received)_(\\d+)\\.${extension}$`, 'i');
                const existingFiles    = fs.readdirSync(finalFolder).filter(f => fileMatchPattern.test(f));
                const nextIndex        = existingFiles.length + 1;
                const fileName         = `${rawContact}_${fromMe ? 'send' : 'received'}_${nextIndex}.${extension}`;
                const filePath         = path.join(finalFolder, fileName);

                fs.writeFileSync(filePath, buffer);

                const directionDB = fromMe ? 'Enviado' : 'Recibido';
                if (mediaTypeInfo?.type === 'audio' && !fromMe) {
                    logger.info(`Audio recibido de ${rawContact} guardado en ${filePath}, NO se guarda en la DB (según requerimiento).`);
                    return; // Omitir registro en DB
                }

                const logMsg = `[${typeLabel.toUpperCase()} ${directionDB} - ${fileName}]`;
                if (fromMe) await this.mongoService.updateDocAfterSend   (this.collection, rawContact, logMsg, myNumber);
                else        await this.mongoService.updateDocAfterReceive(this.collection, rawContact, logMsg, myNumber);

                conversation.addMessage(directionDB, logMsg);
                conversation.display();

                logger.info(`Multimedia ${directionDB} (${typeLabel}) guardado en ${filePath} para contacto ${rawContact}.`);
                return;
            }

            // ---------------------------------------------------------
            // C) Otros tipos (ignorar)
            // ---------------------------------------------------------
            if (DEBUG_MODE) console.log('[DEBUG] No es texto ni media. Se ignora o maneja aparte.');
        } catch (error) {
            console.error(`Error al procesar el mensaje entrante: ${error.message}`);
            logger.error(`Error al procesar el mensaje entrante: ${error.stack}`);
        }
    }

    // -----------------------------------------------------------------
    // TRANSCRIPCIONES
    // -----------------------------------------------------------------
    startTranscriptionChecker() {
        const INTERVAL_MS = 10000;
        setInterval(() => {
            this.checkTranscriptions().catch(err => {
                console.error(`Error en checkTranscriptions: ${err.message}`);
                logger.error(`Error en checkTranscriptions: ${err.stack}`);
            });
        }, INTERVAL_MS);

        if (DEBUG_MODE) console.log(`[DEBUG] Iniciado chequeo de transcripciones cada ${INTERVAL_MS/1000} seg.`);
    }

    async checkTranscriptions() {
        const client = this.clientManager.getClient(); // Cliente PRIMARIO
        if (!client) return;

        const collection = this.collection;
        const myNumber   = client.getClientInfo().wid.user;

        const baseDir    = __dirname;
        const folderEntries = fs.readdirSync(baseDir, { withFileTypes: true });

        for (const folderEntry of folderEntries) {
            if (!folderEntry.isDirectory()) continue;
            const folderName = folderEntry.name;

            // Carpetas a omitir
            if (
                folderName === 'auth' ||
                folderName === 'node_modules' ||
                folderName.startsWith('.')
            ) continue;

            const folderPath = path.join(baseDir, folderName);
            const txtFiles   = fs.readdirSync(folderPath).filter(f => f.toLowerCase().endsWith('.txt'));

            for (const txtFile of txtFiles) {
                const fullTxtPath = path.join(folderPath, txtFile);

                if (this.processedTranscriptions.has(fullTxtPath)) continue;

                const regex = /^(?<phone>\d+)_(?<direction>send|received)_(\d+)\.txt$/i;
                const match = txtFile.match(regex);
                if (!match?.groups) {
                    this.processedTranscriptions.add(fullTxtPath);
                    fs.unlinkSync(fullTxtPath);
                    continue;
                }

                const contactNumber = match.groups.phone;
                const direction     = match.groups.direction;

                let content = '';
                try       { content = fs.readFileSync(fullTxtPath, 'utf8').trim(); }
                catch(err){ console.error(`[ROBUST] No se pudo leer ${fullTxtPath}. Reintento posterior: ${err.message}`); continue; }

                if (!content) {
                    this.processedTranscriptions.add(fullTxtPath);
                    fs.unlinkSync(fullTxtPath);
                    continue;
                }

                const finalMsg = `Transcripción del audio - [${contactNumber}]\n${content}`;

                try {
                    await client.sendMessage(MY_NUMBER, finalMsg);

                    if (direction === 'send')
                         await collection.updateOne(
                             { _id: contactNumber },
                             { $push: { messages: { direction:'Enviado',  content:finalMsg, timestamp:new Date(), sender:myNumber,      recipient:contactNumber } } },
                             { upsert: true }
                         );
                    else await collection.updateOne(
                             { _id: contactNumber },
                             { $push: { messages: { direction:'Recibido', content:finalMsg, timestamp:new Date(), sender:contactNumber, recipient:myNumber   } } },
                             { upsert: true }
                         );

                    logger.info(`Transcripción procesada y reenviada a MI NÚMERO (${MY_NUMBER}). Archivo: ${txtFile}`);
                } catch (errSend) {
                    console.error(`Error al enviar o guardar la transcripción de ${txtFile}: ${errSend.message}`);
                    logger.error(`Error en sendMessage/updateDB: ${errSend.stack}`);
                }

                this.processedTranscriptions.add(fullTxtPath);
                fs.unlinkSync(fullTxtPath);
            }
        }
    }
}

// ---------------------------------------------------------------------
// EJECUCIÓN
// ---------------------------------------------------------------------
(async () => {
    const app = new Application();
    await app.run();
})();
