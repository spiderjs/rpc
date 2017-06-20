import { only, skip, slow, suite, test, timeout } from 'mocha-typescript';
import rx = require('rx');
import rpc = require('../src');
import auth = require('./auth');
import log4js = require('log4js');
import assert = require('assert');

const logger = log4js.getLogger('test');

class Server {
    constructor(private peer: rpc.IRPC) {

    }

    public getHello(message: string): rx.Observable<string> {
        this.peer.call<string>('GET /client/hello', { message: 'test' }).subscribe((val) => {
            logger.debug(val);
        });

        assert(message === 'test');
        return rx.Observable.just('server');
    }

    public postHello(user: any, message: string): rx.Observable<string> {

        return rx.Observable.create<string>((observer) => {
            assert(message === 'test');
            logger.debug('user:', user);
            assert(user.name === 'hello');
            this.peer.call<string>('POST /client/hello', { message: 'test', extend: 'extend' }).subscribe((val) => {
                observer.onNext(val);
                observer.onCompleted();
                logger.debug('post hello', val);
            }, (error) => {
                observer.onError(`POST /client/hello error:${JSON.stringify(error)}`);
            });
        });
    }
}

// tslint:disable-next-line:max-classes-per-file
class Client {
    public getHello(message: string): rx.Observable<string> {
        return rx.Observable.just('client');
    }

    public postHello(user: any, message: string, extend: string): rx.Observable<string> {
        assert(user.name === 'hello');
        assert(extend === 'extend');
        return rx.Observable.just(message);
    }
}

const server = new rpc.TCPServer<auth.IUser>({ auth: new auth.Auth() });

server.on('connection', (peer: rpc.IRPC) => {
    peer.on('close', () => {

    });
    peer.accept('server', new Server(peer));
});

server.listen(8080);

const client = new rpc.TCPClient<auth.IUser>({ auth: new auth.Auth() });

let clientRPC: rpc.IRPC;

// tslint:disable-next-line:max-classes-per-file
@suite('rpc over tcp test')
class TCPTest {

    @test('connect test')
    // tslint:disable-next-line:ban-types
    public connectTest(done: Function) {
        client.on('connection', (peer: rpc.IRPC) => {
            clientRPC = peer;
            clientRPC.accept('client', new Client());
            done();
        });

        client.connect(8080);
    }

    @test('get call server')
    // tslint:disable-next-line:ban-types
    public callServer(done: Function) {
        clientRPC.call<string>('GET /server/hello', { message: 'test' }).subscribe(() => {
            done();
        }, (error) => {
            done(error);
        });
    }

    @test('post call server')
    // tslint:disable-next-line:ban-types
    public postServer(done: Function) {
        clientRPC.call<string>('POST /server/hello', { message: 'test' }).subscribe(() => {
            done();
        }, (error) => {
            done(error);
        });
    }

    @test('post 404 test')
    // tslint:disable-next-line:ban-types
    public post404(done: Function) {
        clientRPC.call<string>('POST /server/hello1', { message: 'test' }).subscribe(() => {
            done(`unknown 404 test failed`);
        }, (error) => {
            assert(error.code === 'RESOURCE_NOT_FOUND');
            done();
        });
    }
};
