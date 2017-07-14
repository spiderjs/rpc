import net = require('net');
import rpc = require('../rpc');
import events = require('events');
import log4js = require('log4js');
import apihandler = require('apihandler');
import config = require('config');

const logger = log4js.getLogger('nrpc-tcp-client');

// tslint:disable-next-line:interface-name
export interface TCPClientOptions<TUser> {
    auth: rpc.IAuth<TUser>;
    loader?: apihandler.ILoader;
    timeout?: number;
}

export class TCPClient<TUser> extends events.EventEmitter {
    private client: net.Socket;
    private port: number;
    private host?: string;
    private closed = false;
    private maxRetryTimeout = 20000;
    private retryTimeout = 1000;
    constructor(private options: TCPClientOptions<TUser>) {
        super();

        if (config.has('nrpc.tcp.retrytimeout')) {
            this.maxRetryTimeout = config.get<number>('nrpc.tcp.retrytimeout') * 1000;
        }
    }

    public connect(port: number, hostname?: string) {
        this.closed = false;
        this.port = port;
        this.host = hostname;
        this.createClient();
        this.client.connect(port, hostname);
    }

    public close() {
        this.closed = true;
    }

    private createClient() {
        const client = new net.Socket();
        // tslint:disable-next-line:no-empty
        client.on('connect', () => {
            logger.info('##########');

            const peer = this.createPeer(client);
            // tslint:disable-next-line:max-line-length
            logger.debug(`created rpc peer for [${client.localAddress}:${client.localPort} => ${client.remoteAddress}:${client.remotePort}]`);

            peer.on('accept', () => {
                // tslint:disable-next-line:max-line-length
                logger.debug(`accept by server peer [${client.localAddress}:${client.localPort} => ${client.remoteAddress}:${client.remotePort}]`);
                this.emit('connection', peer);
            });

            peer.open();
        });

        client.on('error', (error) => {
            // tslint:disable-next-line:max-line-length
            logger.error(`[${client.localAddress}:${client.localPort} => ${client.remoteAddress}:${client.remotePort}] raise error`, error);
            if (!this.closed) {
                this.reconnect();
            }

        });

        client.on('close', (haserror) => {
            if (!haserror && !this.closed) {
                this.reconnect();
            }
        });

        this.client = client;
    }

    private reconnect() {
        setTimeout(() => {
            this.retryTimeout = this.retryTimeout * 2;

            if (this.retryTimeout > this.maxRetryTimeout) {
                this.retryTimeout = this.maxRetryTimeout;
            }

            this.connect(this.port, this.host);
        }, this.retryTimeout);
    }

    private createPeer(connection: net.Socket): rpc.Peer<TUser> {
        return new rpc.Peer<TUser>({
            auth: this.options.auth,
            duplex: connection,
            loader: this.options.loader,
            // tslint:disable-next-line:max-line-length
            name: `[${connection.localAddress}:${connection.localPort} => ${connection.remoteAddress}:${connection.remotePort}]`,
            timeout: this.options.timeout,
        });
    }

};
