import net = require('net');
import rpc = require('../rpc');
import events = require('events');
import log4js = require('log4js');
import apihandler = require('apihandler');

const logger = log4js.getLogger('nrpc-tcp-server');

// tslint:disable-next-line:interface-name
export interface TCPServerOptions<TUser> {
    auth: rpc.IAuth<TUser>;
    server?: net.Server;
    loader?: apihandler.ILoader;
    timeout?: number;
}

export class TCPServer<TUser> extends events.EventEmitter {

    constructor(private options: TCPServerOptions<TUser>) {
        super();

        if (!this.options.server) {
            this.options.server = net.createServer();
        }

        this.getServer().on('connection', (connection) => {

            // tslint:disable-next-line:max-line-length
            const peerName = `[${connection.localAddress}:${connection.localPort} => ${connection.remoteAddress}:${connection.remotePort}]`;

            const peer = this.createPeer(connection);
            // tslint:disable-next-line:max-line-length
            logger.debug(`created rpc peer for ${peerName}`);

            let accepted = false;

            peer.on('accept', () => {
                // tslint:disable-next-line:max-line-length
                logger.debug(`accept by client peer ${peerName}`);
                this.emit('connection', peer);

                accepted = true;
            });

            connection.on('close', (haderror) => {
                if (haderror) {
                    // tslint:disable-next-line:max-line-length
                    logger.error(`rpc peer${peerName} cloed with error`);
                } else {
                    // tslint:disable-next-line:max-line-length
                    logger.error(`rpc peer${peerName} cloed`);
                }

                peer.emit('close', haderror);
            });

            connection.on('error', (error) => {
                // tslint:disable-next-line:max-line-length
                logger.error(`${peerName} raised error:\n\t${error.toString()}`);
                if (accepted) {
                    peer.emit('error', error);
                }

            });

            peer.open();
        });
    }

    // tslint:disable-next-line:ban-types
    public listen(port: number, hostname?: string, backlog?: number, listeningListener?: Function) {
        return this.getServer().listen(port, hostname, backlog, listeningListener);
    }

    private createPeer(connection: net.Socket): rpc.IRPC {
        return new rpc.Peer<TUser>({
            auth: this.options.auth,
            duplex: connection,
            loader: this.options.loader,
            // tslint:disable-next-line:max-line-length
            name: `[${connection.localAddress}:${connection.localPort} => ${connection.remoteAddress}:${connection.remotePort}]`,
            timeout: this.options.timeout,
        });
    }

    private getServer(): net.Server {
        return this.options.server as net.Server;
    }
};
