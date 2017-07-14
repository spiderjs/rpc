import rx = require('rx');
import events = require('events');
import stream = require('stream');
import apihandler = require('apihandler');
import streamBuffers = require('stream-buffers');
import log4js = require('log4js');

const logger = log4js.getLogger('nrpc');

export interface IRPC {
    getUser(): any | undefined;
    call<T>(name: string, params?: any): rx.Observable<T>;
    accept(name: string, service: any): this;
    open(): void;
    // tslint:disable-next-line:ban-types
    on(event: string, listener: Function): this;
    emit(event: string | symbol, ...args: any[]): boolean;
};

export interface IAuth<TUser> {
    handshake(): Buffer;
    accept(buffer: Buffer): rx.Observable<apihandler.IUser<TUser>>;
}

interface IResult {
    code: string;
    errmsg?: string;
    data: any;
}

enum Code {
    REQ = 0,
    RESP = 1,
    AUTH = 2,
    AUTH_ACCEPT = 3,
    AUTH_REJECT = 4,
}

enum State {
    INIT = 0,
    HANDSHAKE = 1,
    REJECT = 2,
    ACCEPT_BY_PEER = 3,
    ACCEPT_PEER = 4,
    ACCEPT = 5,
}

// tslint:disable-next-line:interface-name
export interface Options<TUser> {
    name: string;
    auth: IAuth<TUser>;
    duplex: stream.Duplex;
    loader?: apihandler.ILoader;
    timeout?: number;
}

interface IContext {
    F: (error: any, result?: any) => void;
    timestamp: number;
}

export class Peer<TUser> implements IRPC {
    private user?: apihandler.IUser<TUser>;
    private idgen = 0;
    private context: apihandler.IContext;
    private pending = new Map<number, IContext>();
    private streamBuffer = new streamBuffers.ReadableStreamBuffer();
    private recvBuffer = new streamBuffers.WritableStreamBuffer();
    private timer: number;
    private state = State.INIT;

    private emitter = new events.EventEmitter();

    constructor(private options: Options<TUser>) {

        if (!options.loader) {
            options.loader = new apihandler.ConfigFileLoader();
        }

        if (!options.timeout) {
            options.timeout = 5000;
        }

        this.context = new apihandler.Context(options.loader as apihandler.ILoader);
    }

    public getUser(): any | undefined {
        if (!this.user) {
            return undefined;
        }

        return this.user.content;
    }

    // tslint:disable-next-line:ban-types
    public on(event: string, listener: Function): this {
        this.emitter.on(event, listener);
        return this;
    }

    public emit(event: string | symbol, ...args: any[]): boolean {
        return this.emitter.emit(event, ...args);
    }

    public open() {
        this.init();
        logger.trace(`${this.options.name} start handshake`);
        this.handlshake();
    }

    public close() {
        clearInterval(this.timer);
        this.options.duplex.end();
    }

    public call<T>(name: string, params?: any): rx.Observable<T> {

        if (!params) {
            params = {};
        }

        if (this.state !== State.ACCEPT) {
            return rx.Observable.throwError<T>(new Error(`RPC state error(${this.state})`));
        }

        const id = this.idgen;
        this.idgen++;

        const call = JSON.stringify({ id, name, params });

        logger.trace(`call [${name}]`, call);

        const length = Buffer.byteLength(call);

        const buffer = Buffer.alloc(6 + length);

        buffer.writeUInt16BE(Code.REQ, 0);
        buffer.writeUInt32BE(length, 2);
        buffer.write(call, 6);

        logger.trace(`call [${name}] ${buffer.toString('UTF-8', 6)}`);

        this.streamBuffer.push(buffer);

        return rx.Observable.create<T>((observer) => {
            this.pending.set(id, {
                F: (error: any, result: any) => {
                    if (error) {
                        observer.onError(error);
                    } else {
                        if (Array.isArray(result)) {
                            for (const val of result) {
                                observer.onNext(val);
                            }
                        } else {
                            observer.onNext(result);
                        }

                        observer.onCompleted();
                    }
                },
                timestamp: Date.now(),
            });
        });
    }

    public accept(name: string, service: any): this {
        this.context.bind(name, service);
        return this;
    }

    private init() {
        this.streamBuffer.pipe(this.options.duplex);

        this.streamBuffer.on('error', (error) => {
            this.emit('error', error);
        });

        this.timer = setInterval(() => {
            this.handleTimeout();
        }, this.options.timeout);

        this.options.duplex.on('data', (data) => {
            logger.trace(`${this.options.name} recv data:${JSON.stringify(data)}`);
            this.recvBuffer.write(data);

            while (true) {
                if (this.recvBuffer.size() < 6) {
                    return;
                }

                const header = this.recvBuffer.getContents(6);
                logger.trace(`${this.options.name} ${JSON.stringify(header)}`);
                const code = header.readUInt16BE(0);
                const length = header.readUInt32BE(2);

                logger.trace(`${this.options.name} recv request(${code},${length})`);

                if (length > this.recvBuffer.size()) {

                    logger.trace(`expect data(${length}) current length(${this.recvBuffer.size()})`);

                    const body = this.recvBuffer.getContents();

                    logger.trace(`####### body`, body);

                    this.recvBuffer.write(header);

                    if (body) {
                        this.recvBuffer.write(body);
                    }

                    return;
                }

                logger.trace(`${this.options.name} recv request(${code},${length}) -- whole`);

                if (length === 0) {
                    this.onData(code, Buffer.alloc(0));
                } else {
                    const body = this.recvBuffer.getContents(length);

                    this.onData(code, body);
                }
            }
        });
    }

    private handleTimeout() {
        const pending = new Map<number, IContext>();

        for (const key of this.pending.keys()) {
            const context = this.pending.get(key);
            if (context) {
                if ((Date.now() - context.timestamp) < (this.options.timeout as number)) {
                    pending.set(key, context);
                    continue;
                }

                context.F(new Error(`RPC_TIMEOUT(${key})`));
            }
        }
    }


    private handlshake() {
        const id = this.idgen;
        this.idgen++;

        const body = this.options.auth.handshake();

        const header = Buffer.alloc(6);

        header.writeUInt16BE(Code.AUTH, 0);
        header.writeUInt32BE(body.length, 2);

        this.streamBuffer.push(header);
        this.streamBuffer.push(body);

        this.state = State.HANDSHAKE;
    }

    private onResponse(data: any) {
        const call = JSON.stringify(data);

        const buffer = Buffer.alloc(6 + call.length);

        buffer.writeUInt16BE(Code.RESP, 0);
        buffer.writeUInt32BE(call.length, 2);
        buffer.write(call, 6);

        this.streamBuffer.push(buffer);
    }

    private handleRequest(code: Code, data: any) {
        logger.trace(`recv call(${data.name}) with params:${JSON.stringify(data.params)}`);
        this.context.call<any, TUser>({
            name: data.name,
            params: data.params,
            user: this.user,
        }).reduce((list: any[], item: any) => {
            list.push(item);
            return list;
        }, []).subscribe((result: any) => {
            logger.trace(`####`);
            if (result.length === 1) {
                this.onResponse({
                    code: 'SUCCESS',
                    data: result[0],
                    id: data.id,
                });
            } else if (result.length === 0) {
                this.onResponse({
                    code: 'RESOURCE_NOT_FOUND',
                    errmsg: `resource not found`,
                    id: data.id,
                });
            } else {
                this.onResponse({
                    code: 'SUCCESS',
                    data: result,
                    id: data.id,
                });
            }
        }, (error) => {
            this.onResponse({
                code: error.code ? error.code : 'RPC_ERROR',
                errmsg: error.errmsg ? error.errmsg : error.toString(),
                id: data.id,
            });
        });
    }

    private handleResponse(code: Code, data: any) {
        const context = this.pending.get(data.id);
        this.pending.delete(data.id);
        if (!context) {
            logger.warn(`can't find request context(${data.id})`);
            return;
        }

        if (data.code !== 'SUCCESS') {
            context.F(data);
        } else {
            context.F(undefined, data.data);
        }

    }

    private handleAuth(code: Code, data: Buffer) {

        logger.trace(`${this.options.name} handle auth(${this.state})`);

        if (this.state === State.REJECT) {
            const body = JSON.stringify({
                code: 'AUTH_FAILED',
                errmsg: `invalid peer status REJECT`,
            });
            const buffer = Buffer.alloc(6 + body.length);

            buffer.writeUInt16BE(Code.AUTH_ACCEPT, 0);
            buffer.writeUInt32BE(body.length, 2);
            buffer.write(body, 6);

            this.streamBuffer.push(buffer);

            return;
        }

        this.options.auth.accept(data).subscribe((user) => {


            if (this.state === State.HANDSHAKE || this.state === State.INIT) {
                this.state = State.ACCEPT_PEER;
            } else if (this.state === State.ACCEPT_BY_PEER) {
                this.state = State.ACCEPT;
                this.emit('accept');
            } else {
                this.state = State.REJECT;
                this.emit('reject');
                logger.error(`reject auth request by invalid status ${this.state}`);
                const body = JSON.stringify({
                    code: 'AUTH_FAILED',
                    errmsg: `reject auth request by invalid status ${this.state}`,
                });
                const buffer = Buffer.alloc(6 + body.length);
                buffer.writeUInt16BE(Code.AUTH_ACCEPT, 0);
                buffer.writeUInt32BE(body.length, 2);
                buffer.write(body, 6);
                this.streamBuffer.push(buffer);
                return;
            }

            this.user = user;
            const body = JSON.stringify({ code: 'SUCCESS' });
            const buffer = Buffer.alloc(6 + body.length);

            buffer.writeUInt16BE(Code.AUTH_ACCEPT, 0);
            buffer.writeUInt32BE(body.length, 2);
            buffer.write(body, 6);

            this.streamBuffer.push(buffer);

        }, (error) => {
            this.emit('reject');
            this.state = State.REJECT;
            const body = JSON.stringify({
                code: 'AUTH_FAILED',
                errmsg: `${error.toString()}`,
            });
            const buffer = Buffer.alloc(6 + body.length);

            buffer.writeUInt16BE(Code.AUTH_ACCEPT, 0);
            buffer.writeUInt32BE(body.length, 2);
            buffer.write(body, 6);

            this.streamBuffer.push(buffer);
        });
    }

    private handleAuthResp(code: Code, data: any) {
        logger.trace(`${this.options.name} ${this.state} ${JSON.stringify(data)}`);
        if (data.code !== 'SUCCESS') {
            logger.error(`auth response(${data.code}) :${data.errmsg}`);
            this.state = State.REJECT;
            this.emit('reject');
            return;
        }

        if (this.state === State.HANDSHAKE) {
            this.state = State.ACCEPT_BY_PEER;
        } else if (this.state === State.ACCEPT_PEER) {
            logger.trace(`${this.options.name} ACCEPT`);
            this.state = State.ACCEPT;
            this.emit('accept');
        } else {
            logger.error(`invalid status ${this.state} drop auth response`);
            this.state = State.REJECT;
            this.emit('reject');

        }
    }

    private onData(code: Code, data: Buffer) {

        try {
            switch (code) {
                case Code.REQ: {
                    this.handleRequest(code, JSON.parse(data.toString()));
                    break;
                }
                case Code.RESP: {
                    this.handleResponse(code, JSON.parse(data.toString()));
                    break;
                }
                case Code.AUTH: {
                    this.handleAuth(code, data);
                    break;
                }
                case Code.AUTH_ACCEPT: {
                    this.handleAuthResp(code, JSON.parse(data.toString()));
                    break;
                }
                default: {
                    logger.error(`recv unknown message with code:${code}`);
                }
            }
        } catch (error) {
            logger.error(`handle uncatched error`, error, data.toString());
        }
    }
}
