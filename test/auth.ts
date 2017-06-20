import rx = require('rx');
import rpc = require('../src');
import apihandler = require('apihandler');

export interface IUser {
    name: string;
}

export class Auth implements rpc.IAuth<IUser> {
    public handshake(): Buffer {
        return Buffer.alloc(0);
    }
    public accept(buffer: Buffer): rx.Observable<apihandler.IUser<IUser>> {
        return rx.Observable.just({
            content: {
                name: 'hello',
            },
            roles: ['server'],
        });
    }
}
