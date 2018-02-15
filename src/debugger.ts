/**
 * @file VSCode HHVM Debugger Adapter
 *
 * HHVM already speaks the vscode debugger protocol, so ideally this module would
 * have been unnecessary and vscode could directly launch or attach to a HHVM process.
 * However, vscode expects debugger communication through stdin/stdout, while HHVM
 * needs those for running the program itself and instead exposes the debugger over a
 * TCP port. This adapter is thus a thin Node executable that connects the two.
 *
 * The current implementation is copied from Nuclide's HHVM debug adapter at
 * https://github.com/facebook/nuclide/blob/master/pkg/nuclide-debugger-hhvm-rpc/lib/hhvmDebugger.js
 *
 */

import * as child_process from 'child_process';
import * as fs from 'fs';
import * as net from 'net';
import { OutputEvent } from 'vscode-debugadapter';
import { DebugProtocol } from 'vscode-debugprotocol';

const TWO_CRLF = '\r\n\r\n';
const CONTENT_LENGTH_PATTERN = new RegExp('Content-Length: (\\d+)');
const DEFAULT_HHVM_DEBUGGER_PORT = 8999;

type DebuggerWriteCallback = (data: string) => void;

class HHVMDebuggerWrapper {
    private sequenceNumber: number;
    private currentOutputData: string;
    private currentInputData: string;
    private currentContentLength: number;
    private bufferedRequests: DebugProtocol.Request[];
    private debugging: boolean;
    private debuggerWriteCallback: DebuggerWriteCallback | undefined;

    constructor() {
        this.sequenceNumber = 0;
        this.currentContentLength = 0;
        this.currentOutputData = '';
        this.currentInputData = '';
        this.bufferedRequests = [];
        this.debugging = false;
    }

    public debug() {
        fs.writeFileSync('/tmp/ext.log', 'Started debugging.\n');
        process.stdin.on('data', chunk => {
            this.processClientMessage(chunk);
        });
    }

    private attachTarget(attachMessage: DebugProtocol.Request, retries: number = 0) {
        const args: any = attachMessage.arguments || {};
        const attachPort = args.port
            ? parseInt(args.port, 10)
            : DEFAULT_HHVM_DEBUGGER_PORT;

        if (Number.isNaN(attachPort)) {
            fs.appendFileSync('/tmp/ext.log', 'Invalid HHVM debug port specified\n');
            throw new Error('Invalid HHVM debug port specified.');
        }

        fs.appendFileSync('/tmp/ext.log', `Attaching to port:${attachPort}\n`);

        const socket = new net.Socket();
        socket
            .once('connect', () => {
                fs.appendFileSync('/tmp/ext.log', 'Socket event: connect\n');
                const callback = (data: string) => {
                    socket.write(`${data}\0`, 'utf8');
                };

                callback(JSON.stringify(attachMessage));
                this.debuggerWriteCallback = callback;
                this.forwardBufferedMessages();
                this.debugging = true;

                const attachResponse = {
                    request_seq: attachMessage.seq,
                    success: true,
                    command: attachMessage.command
                };
                this.writeResponseMessage(attachResponse);
            })
            .on('data', chunk => {
                fs.appendFileSync('/tmp/ext.log', `Received socket message: ${chunk.toString()} .\n`);
                this.processDebuggerMessage(chunk);
            })
            .on('close', () => {
                fs.appendFileSync('/tmp/ext.log', 'Socket event: close\n');
                process.exit(0);
            })
            .on('disconnect', () => {
                fs.appendFileSync('/tmp/ext.log', 'Socket event: disconnect\n');
                process.stderr.write(
                    'The connection to the debug target has been closed.'
                );
                process.exit(0);
            })
            .on('error', error => {
                fs.appendFileSync('/tmp/ext.log', `Socket event: error\nMessage:${error.toString()}\n`);
                if (retries >= 5) {
                    process.stderr.write(
                        `Error communicating with debugger target: ${error.toString()}`
                    );
                    process.exit((<any>error).code);
                } else {
                    // When reconnecting to a target we just disconnected from, especially
                    // in the case of an unclean disconnection, it may take a moment
                    // for HHVM to receive a TCP socket error and realize the client is
                    // gone. Rather than failing to reconnect, wait a moment and try
                    // again to provide a better user experience.
                    setTimeout(() => { this.attachTarget(attachMessage, retries + 1); }, 1000);
                }
            });

        socket.connect({ port: attachPort, host: 'localhost' });
    }

    private launchTarget(launchMessage: DebugProtocol.Request) {
        const args: any = launchMessage.arguments || {};
        const hhvmPath = 'hhvm';
        /*if (!hhvmPath || hhvmPath === '') {
            throw new Error('Expected a path to HHVM.');
        }*/

        // const hhvmArgs = args.hhvmArgs;
        const hhvmArgs = ['--mode', 'vsdebug', '--vsDebugPort', '8999', '--vsDebugNoWait', '1', '/home/pranay/repos/hacktest/first.php'];
        const options = {
            cwd: args.cwd ? args.cwd : process.cwd(),
            // FD[3] is used for communicating with the debugger extension.
            // STDIN, STDOUT and STDERR are the actual PHP streams.
            // If launchMessage.noDebug is specified, start the child but don't
            // connect the debugger fd pipe.
            stdio: Boolean(args.noDebug)
                ? ['pipe', 'pipe', 'pipe']
                : ['pipe', 'pipe', 'pipe', 'pipe'],
            // When the wrapper exits, so does the target.
            detached: false,
            env: process.env
        };

        const targetProcess = child_process.spawn(hhvmPath, hhvmArgs, options);

        fs.appendFileSync('/tmp/ext.log', 'Launched HHVM\n');

        // Exit with the same error code the target exits with.
        targetProcess.on('exit', code => process.exit(code));
        targetProcess.on('error', error => process.stderr.write(error.toString()));

        // Wrap any stdout from the target into a VS Code stdout event.
        targetProcess.stdout.on('data', chunk => {
            const block: string = chunk.toString();
            this.writeOutputEvent('stdout', block);
        });
        // targetProcess.stdout.on('error', () => { });

        // Wrap any stderr from the target into a VS Code stderr event.
        targetProcess.stderr.on('data', chunk => {
            const block: string = chunk.toString();
            this.writeOutputEvent('stderr', block);
        });
        // targetProcess.stderr.on('error', () => { });

        targetProcess.stdio[3].on('data', chunk => {
            this.processDebuggerMessage(chunk);
        });
        // targetProcess.stdio[3].on('error', () => { });

        // Read data from the debugger client on stdin and forward to the
        // debugger engine in the target.
        const callback = (data: string) => {
            targetProcess.stdin.write(`${data}\0`, 'utf8');
        };

        callback(JSON.stringify(launchMessage));
        this.debuggerWriteCallback = callback;
        this.forwardBufferedMessages();
        this.debugging = true;
    }

    private forwardBufferedMessages() {
        if (this.debuggerWriteCallback !== undefined) {
            const callback = this.debuggerWriteCallback;
            for (const requestMsg of this.bufferedRequests) {
                callback(JSON.stringify(requestMsg));
            }
        }
    }

    private processClientMessage(chunk: Buffer) {
        this.currentInputData += chunk.toString();
        // tslint:disable-next-line:no-constant-condition
        while (true) {
            if (this.currentContentLength === 0) {
                // Look for a content length header.
                this.readContentHeader();
            }

            const length = this.currentContentLength;
            if (length === 0 || this.currentInputData.length < length) {
                // We're not expecting a message, or the amount of data we have
                // available is smaller than the expected message. Wait for more data.
                break;
            }

            const message = this.currentInputData.substr(0, length);
            const requestMsg = JSON.parse(message);
            fs.appendFileSync('/tmp/ext.log', `Parsed request message: ${JSON.stringify(requestMsg)}\n`);
            if (!this.handleWrapperRequest(requestMsg)) {
                const callback = this.debuggerWriteCallback;
                if (callback) {
                    callback(this.translateNuclideRequest(requestMsg));
                }
            }

            // Reset state and expect another content length header next.
            this.currentContentLength = 0;
            this.currentInputData = this.currentInputData.substr(length);
        }
    }

    private translateNuclideRequest(requestMsg: DebugProtocol.Request): string {
        // Nuclide has some extension messages that are not actually part of the
        // VS Code Debug protocol. These are prefixed with "nuclide_" to indicate
        // that they are non-standard requests. Since the HHVM side is agnostic
        // to what IDE it is talking to, these same commands (if they are available)
        // are actually prefixed with a more generic 'fb_' so convert.
        if (requestMsg.command && requestMsg.command.startsWith('nuclide_')
        ) {
            requestMsg.command = requestMsg.command.replace('nuclide_', 'fb_');
            return JSON.stringify(requestMsg);
        }
        return JSON.stringify(requestMsg);
    }

    private handleWrapperRequest(requestMsg: DebugProtocol.Request): boolean {
        // Certain messages should be handled in the wrapper rather than forwarding
        // to HHVM.
        if (requestMsg.command) {
            switch (requestMsg.command) {
                case 'disconnect':
                    this.writeResponseMessage({
                        request_seq: requestMsg.seq,
                        success: true,
                        command: requestMsg.command
                    });

                    // Exit this process, which will also result in the child being killed
                    // (in the case of Launch mode), or the socket to the child being
                    // terminated (in the case of Attach mode).
                    process.exit(0);
                    return true;
                case 'launch':
                    this.launchTarget(requestMsg);
                    return true;

                case 'attach':
                    this.attachTarget(requestMsg);
                    return true;

                /*case 'initialize':
                    this.writeResponseMessage({
                        request_seq: requestMsg.seq,
                        success: true,
                        command: requestMsg.command
                    });*/
                default:
                    break;
            }
        }

        if (!this.debugging) {
            // If debugging hasn't started yet, we need to buffer this request to
            // send to the backend once a connection has been established.
            this.bufferedRequests.push(requestMsg);
            return true;
        }

        return false;
    }

    private processDebuggerMessage(chunk: Buffer) {
        this.currentOutputData += chunk.toString();

        // The messages from HHVM are each terminated by a NULL character.
        // Process any complete messages from HHVM.
        let idx = this.currentOutputData.indexOf('\0');
        while (idx > 0) {
            const message = this.currentOutputData.substr(0, idx);

            // Add a sequence number to the data.
            try {
                const obj = JSON.parse(message);
                obj.seq = ++this.sequenceNumber;
                this.writeOutputWithHeader(JSON.stringify(obj));
            } catch (e) {
                process.stderr.write(
                    `Error parsing message from target: ${e.toString()}: ${message}`
                );
            }

            // Advance to idx + 1 (lose the NULL char)
            this.currentOutputData = this.currentOutputData.substr(idx + 1);
            idx = this.currentOutputData.indexOf('\0');
        }
    }

    private readContentHeader() {
        const idx = this.currentInputData.indexOf(TWO_CRLF);
        if (idx <= 0) {
            return;
        }

        const header = this.currentInputData.substr(0, idx);
        const match = header.match(CONTENT_LENGTH_PATTERN);
        if (!match) {
            throw new Error('Unable to parse message from debugger client');
        }

        // Chop the Content-Length header off the input data and start looking for
        // the message.
        this.currentContentLength = parseInt(match[1], 10);
        this.currentInputData = this.currentInputData.substr(
            idx + TWO_CRLF.length
        );
        ++this.sequenceNumber;
    }

    private writeOutputEvent(eventType: string, message: string) {
        const outputEvent: OutputEvent = {
            seq: ++this.sequenceNumber,
            type: 'event',
            event: 'output',
            body: {
                category: eventType,
                output: message
            }
        };
        this.writeOutputWithHeader(JSON.stringify(outputEvent));
    }

    private writeResponseMessage(message: Object) {
        this.writeOutputWithHeader(
            JSON.stringify({
                seq: ++this.sequenceNumber,
                type: 'response',
                ...message
            })
        );
    }

    private writeOutputWithHeader(output: string) {
        const length = Buffer.byteLength(output, 'utf8');
        process.stdout.write(`Content-Length: ${length}${TWO_CRLF}`, 'utf8');
        process.stdout.write(output, 'utf8');
    }
}

new HHVMDebuggerWrapper().debug();
