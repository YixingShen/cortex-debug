import * as vscode from 'vscode';
import { DebugProtocol } from '@vscode/debugprotocol';
import * as RTOSCommon from './rtos-common';
import { hexFormat } from '../utils';
import { HrTimer } from '../../common';

interface FreeRTOSThreadInfoHeaders {
    'ID'?: string;
    'Address': string;
    'Task Name': string;
    'Status': string;
    'Prio': string;
    'Stack Start': string;
    'Stack Top': string;
    'Stack End'?: string;
    'Stack Size'?: string;
    'Stack Used'?: string;
    'Stack Free'?: string;
    'Stack Peak'?: string;
    'Runtime'?: string;
}
interface FreeRTOSThreadInfo {
    display: FreeRTOSThreadInfoHeaders;
    stackInfo: RTOSCommon.RTOSStackInfo;
}

function isNullOrUndefined(x) {
    return (x === undefined) || (x === null);
}

export class RTOSFreeRTOS extends RTOSCommon.RTOSBase {
    // We keep a bunch of variable references (essentially pointers) that we can use to query for values
    // Since all of them are global variable, we only need to create them once per session. These are
    // similar to Watch/Hover variables
    private uxCurrentNumberOfTasks: RTOSCommon.RTOSVarHelper;
    private uxCurrentNumberOfTasksVal: number;
    private pxReadyTasksLists: RTOSCommon.RTOSVarHelper;
    private pxReadyTasksListsItems: RTOSCommon.RTOSVarHelper[];
    private xDelayedTaskList1: RTOSCommon.RTOSVarHelper;
    private xDelayedTaskList2: RTOSCommon.RTOSVarHelper;
    private xPendingReadyList: RTOSCommon.RTOSVarHelper;
    private pxCurrentTCB: RTOSCommon.RTOSVarHelper;
    private xSuspendedTaskList: RTOSCommon.RTOSVarHelper;
    private xTasksWaitingTermination: RTOSCommon.RTOSVarHelper;
    private ulTotalRunTime: RTOSCommon.RTOSVarHelper;
    private ulTotalRunTimeVal: number;

    private stale: boolean;
    private curThreadAddr: number;
    private foundThreads: FreeRTOSThreadInfo[] = [];
    private finalThreads: FreeRTOSThreadInfo[] = [];
    private timeInfo: string;
    private readonly maxThreads = 1024;

    // Need to do a TON of testing for stack growing the other direction
    private stackIncrements = -1;

    constructor(public session: vscode.DebugSession) {
        super(session, 'FreeRTOS');
    }

    public async tryDetect(useFrameId: number): Promise<RTOSCommon.RTOSBase> {
        this.progStatus = 'stopped';
        try {
            if (this.status === 'none') {
                // We only get references to all the interesting variables. Note that any one of the following can fail
                // and the caller may try again until we know that it definitely passed or failed. Note that while we
                // re-try everything, we do remember what already had succeeded and don't waste time trying again. That
                // is how this.getVarIfEmpty() works
                this.uxCurrentNumberOfTasks = await this.getVarIfEmpty(this.uxCurrentNumberOfTasks, useFrameId, 'uxCurrentNumberOfTasks', false);
                this.pxReadyTasksLists = await this.getVarIfEmpty(this.pxReadyTasksLists, useFrameId, 'pxReadyTasksLists', true);
                this.xDelayedTaskList1 = await this.getVarIfEmpty(this.xDelayedTaskList1, useFrameId, 'xDelayedTaskList1', true);
                this.xDelayedTaskList2 = await this.getVarIfEmpty(this.xDelayedTaskList2, useFrameId, 'xDelayedTaskList2', true);
                this.xPendingReadyList = await this.getVarIfEmpty(this.xPendingReadyList, useFrameId, 'xPendingReadyList', true);
                this.pxCurrentTCB = await this.getVarIfEmpty(this.pxCurrentTCB, useFrameId, 'pxCurrentTCB', false);
                this.xSuspendedTaskList = await this.getVarIfEmpty(this.xSuspendedTaskList, useFrameId, 'xSuspendedTaskList', true, true);
                this.xTasksWaitingTermination = await this.getVarIfEmpty(this.xTasksWaitingTermination, useFrameId, 'xTasksWaitingTermination', true, true);
                this.ulTotalRunTime = await this.getVarIfEmpty(this.ulTotalRunTime, useFrameId, 'ulTotalRunTime', false, true);
                this.status = 'initialized';
            }
            return this;
        }
        catch (e) {
            this.status = 'failed';
            this.failedWhy = e;
            return this;
        }
    }

    public refresh(frameId: number): Promise<void> {
        return new Promise<void>((resolve, reject) => {
            if (this.progStatus !== 'stopped') {
                resolve();
                return;
            }

            const timer = new HrTimer();
            this.stale = true;
            this.timeInfo = (new Date()).toISOString();
            // uxCurrentNumberOfTasks can go invalid anytime. Like when a reset/restart happens
            this.uxCurrentNumberOfTasksVal = Number.MAX_SAFE_INTEGER;
            this.foundThreads = [];
            this.uxCurrentNumberOfTasks.getValue(frameId).then(async (str) => {
                try {
                    this.uxCurrentNumberOfTasksVal = str ? parseInt(str) : Number.MAX_SAFE_INTEGER;
                    if ((this.uxCurrentNumberOfTasksVal > 0) && (this.uxCurrentNumberOfTasksVal <= this.maxThreads)) {
                        if (this.pxReadyTasksListsItems === undefined) {
                            const vars = await this.pxReadyTasksLists.getVarChildren(frameId);
                            const tmpArray = [];
                            for (const v of vars) {
                                tmpArray.push(await this.getVarIfEmpty(undefined, frameId, v.evaluateName, true));
                            }
                            this.pxReadyTasksListsItems = tmpArray;
                        }
                        if (this.ulTotalRunTime) {
                            const tmp = await this.ulTotalRunTime.getValue(frameId);
                            this.ulTotalRunTimeVal = parseInt(tmp);
                        }
                        const cur = await this.pxCurrentTCB.getValue(frameId);
                        this.curThreadAddr = parseInt(cur);
                        let ix = 0;
                        for (const item of this.pxReadyTasksListsItems) {
                            await this.getThreadInfo(item, 'READY', frameId);
                            ix++;
                        }
                        await this.getThreadInfo(this.xDelayedTaskList1, 'BLOCKED', frameId);
                        await this.getThreadInfo(this.xDelayedTaskList2, 'BLOCKED', frameId);
                        await this.getThreadInfo(this.xPendingReadyList, 'BLOCKED', frameId);
                        await this.getThreadInfo(this.xSuspendedTaskList, 'SUSPENDED', frameId);
                        await this.getThreadInfo(this.xTasksWaitingTermination, 'TERMINATED', frameId);
                        if (this.foundThreads[0]['ID'] !== '??') {
                            this.foundThreads.sort((a, b) => parseInt(a.display['ID']) - parseInt(b.display['ID']));
                        } else {
                            this.foundThreads.sort((a, b) => parseInt(a.display['Address']) - parseInt(b.display['Address']));
                        }
                        this.finalThreads = [...this.foundThreads];
                        // console.table(this.finalThreads);
                    } else {
                        this.finalThreads = [];
                    }
                    this.stale = false;
                    this.timeInfo += ' in ' + timer.deltaMs() + ' ms';
                    resolve();
                }
                catch (e) {
                    resolve();
                    console.error('FreeRTOS.refresh() failed: ', e);
                }
            }, (reason) => {
                resolve();
                console.error('FreeRTOS.refresh() failed: ', reason);
            });
        });
    }

    private getThreadInfo(varRef: RTOSCommon.RTOSVarHelper, state: string, frameId: number): Promise<void> {
        return new Promise<void>((resolve, reject) => {
            if (!varRef || !varRef.varReference || (this.foundThreads.length >= this.uxCurrentNumberOfTasksVal)) {
                resolve();
                return;
            }
            if (this.progStatus !== 'stopped') {
                reject(new Error('Busy'));
                return;
            }
            varRef.getVarChildrenObj(frameId).then(async (obj) => {
                const threadCount = parseInt(obj['uxNumberOfItems-val']);
                const listEndRef = obj['xListEnd-ref'];
                if ((threadCount <= 0) || !listEndRef) {
                    resolve();
                    return;
                }
                try {
                    const listEndObj = await this.getVarChildrenObj(listEndRef, 'xListEnd');
                    let curRef = listEndObj['pxPrevious-ref'];
                    for (let thIx = 0; thIx < threadCount; thIx++ ) {
                        const element = await this.getVarChildrenObj(curRef, 'pxPrevious');
                        const threadId = parseInt(element['pvOwner-val']);
                        const thInfo = await this.getExprValChildrenObj(`((TCB_t*)${hexFormat(threadId)})`, frameId);
                        const tmpThName = await this.getExprVal('(char *)' + thInfo['pcTaskName-exp'], frameId);
                        const match = tmpThName.match(/"([^*]*)"$/);
                        const thName = match ? match[1] : tmpThName;
                        const stackInfo = await this.getStackInfo(thInfo, 0xA5);
                        // This is the order we want stuff in
                        const th: FreeRTOSThreadInfo = {
                            display: {
                                'ID'            : thInfo['uxTCBNumber-val'] || '??',
                                'Address'       : hexFormat(threadId),
                                'Task Name'     : thName,
                                'Status'        : (threadId === this.curThreadAddr) ? 'RUNNING' : state,
                                'Prio'          : thInfo['uxPriority-val'],
                                'Stack Start'     : hexFormat(stackInfo.stackStart),
                                'Stack Top'     : hexFormat(stackInfo.stackTop)
                            },
                            stackInfo     : stackInfo
                        };
                        if (thInfo['uxBasePriority-val']) {
                            th.display['Prio'] += `,${thInfo['uxBasePriority-val']}`;
                        }
                        const func = (x) => {
                            return x === undefined ? '???' : x.toString();
                        };
                        th.display['Stack End' ] = stackInfo.stackEnd ? hexFormat(stackInfo.stackEnd) : '0x????????';
                        th.display['Stack Size'] = func(stackInfo.stackSize);
                        th.display['Stack Used'] = func(stackInfo.stackUsed);
                        th.display['Stack Free'] = func(stackInfo.stackFree);
                        th.display['Stack Peak'] = func(stackInfo.stackPeak);
                        if (thInfo['ulRunTimeCounter-val'] && this.ulTotalRunTimeVal) {
                            const tmp = ((parseInt(thInfo['ulRunTimeCounter-val']) / this.ulTotalRunTimeVal) * 100).toFixed(2);
                            th.display['Runtime'] = tmp.padStart(5, '0') + '%';
                        } else {
                            th.display['Runtime'] = '??.??%';
                        }
                        this.foundThreads.push(th);
                        curRef = element['pxPrevious-ref'];
                    }
                    resolve();
                }
                catch (e) {
                    console.log('FreeRTOS read thread info error', e);
                }
            }, (e) => {
                reject(e);
            });
        });
    }

    protected async getStackInfo(thInfo: any, waterMark: number) {
        const pxStack = thInfo['pxStack-val'];
        const pxTopOfStack = thInfo['pxTopOfStack-val'];
        const pxEndOfStack = thInfo['pxEndOfStack-val'];
        const stackInfo: RTOSCommon.RTOSStackInfo = {
            stackStart: parseInt(pxStack),
            stackTop: parseInt(pxTopOfStack)
        };
        const stackDelta = Math.abs(stackInfo.stackTop - stackInfo.stackStart);
        if (this.stackIncrements < 0) {
            stackInfo.stackFree = stackDelta;
        } else {
            stackInfo.stackUsed = stackDelta;
        }

        if (pxEndOfStack) {
            stackInfo.stackEnd = parseInt(pxEndOfStack);
            stackInfo.stackSize = Math.abs(stackInfo.stackStart - stackInfo.stackEnd);
            if (this.stackIncrements < 0) {
                stackInfo.stackUsed = stackInfo.stackSize - stackDelta;
            } else {
                stackInfo.stackFree = stackInfo.stackSize - stackDelta;
            }
            const memArg: DebugProtocol.ReadMemoryArguments = {
                memoryReference: hexFormat(Math.min(stackInfo.stackStart, stackInfo.stackEnd)),
                count: stackInfo.stackSize
            };
            try {
                const stackData = await this.session.customRequest('readMemory', memArg);
                const buf = Buffer.from(stackData.data, 'base64');
                stackInfo.bytes = new Uint8Array(buf);
                let start = this.stackIncrements < 0 ? 0 : stackInfo.bytes.length - 1;
                const end = this.stackIncrements < 0 ? stackInfo.bytes.length : -1;
                let peak = 0;
                while (start !== end) {
                    if (stackInfo.bytes[start] !== waterMark) {
                        break;
                    }
                    start -= this.stackIncrements;
                    peak++;
                }
                stackInfo.stackPeak = stackInfo.stackSize - peak;
            }
            catch (e) {
                console.log(e);
            }
        }
        return stackInfo;
    }

    public lastValidHtml: string = '';
    public getHTML(): string {
        // WARNING: This stuff is super fragile. Once we know what we works, them we should refactor this
        let ret = '';
        if (this.status === 'none') {
            return '<p>RTOS not yet fully initialized. Will occur next time program pauses</p>\n';
        } else if (this.stale) {
            let msg = '';
            let lastHtml = this.lastValidHtml;
            if (this.uxCurrentNumberOfTasksVal === Number.MAX_SAFE_INTEGER) {
                msg = 'Count not read "uxCurrentNumberOfTasks". Perhaps program is busy or did not stop long enough';
                lastHtml = '';
            } else if (this.uxCurrentNumberOfTasksVal > this.maxThreads) {
                msg = `FreeRTOS variable uxCurrentNumberOfTasks = ${this.uxCurrentNumberOfTasksVal} seems invalid`;
                lastHtml = '';
            } else if (lastHtml) {
                msg = ' Following info from last query may be stale.';
            }
            return `<p>Unable to collect full RTOS information. ${msg}</p>\n` + lastHtml;
        } else if ((this.uxCurrentNumberOfTasksVal !== Number.MAX_SAFE_INTEGER) && (this.finalThreads.length !== this.uxCurrentNumberOfTasksVal)) {
            ret += `<p>Expecting ${this.uxCurrentNumberOfTasksVal} threads, found ${this.finalThreads.length}. Thread data may be unreliable<p>\n`;
        } else if (this.finalThreads.length === 0) {
            return `<p>No ${this.name} threads detected, perhaps RTOS not yet initialized or tasks yet to be created!</p>\n`;
        }
        
        const keys = Object.keys(this.finalThreads[0].display);
        const keys2 = [];
        let normalRowFmt = '';
        let curCol = 1;
        let stBeg = 0;
        let stEnd = 0;
        for (const k of keys) {
            const lowerk = k.toLowerCase();
            let tmp = 3;
            if (k === 'ID') {
                tmp = 1;
            } else if (k === 'Task Name') {
                tmp = 4;
            } else if (k === 'Prio') {
                tmp = 1.5;
            } else if (k === 'Runtime') {
                tmp = 2;
            }
            if (lowerk.startsWith('stack ')) {
                const type = k.substring(6).toLowerCase().trim();
                tmp = ((type === 'start') || (type === 'top') || (type === 'end')) ? 3 : 2;
                if (!stBeg) { stBeg = curCol; }
                stEnd = curCol;
                keys2.push(k.substring(6).trim());
            } else if (k === 'Prio') {
                keys2.push('rity');
            } else {
                keys2.push(k);
            }
            curCol++;
            normalRowFmt += `${tmp}fr `;
        }

        let table = `<vscode-data-grid class="${this.name}-grid threads-grid" grid-template-columns="${normalRowFmt}">\n`;
        let header = '';
        for (const thr of this.finalThreads) {
            const th = thr.display;
            if (!header) {
                let col = 1;
                const commonHeaderRowPart = '  <vscode-data-grid-row row-type="header" class="threads-header-row">\n';
                const commonHeaderCellPart = '    <vscode-data-grid-cell cell-type="columnheader" class="threads-header-cell" grid-column=';
                header = commonHeaderRowPart;
                for (const key of keys) {
                    if ((col >= stBeg) && (col <= stEnd)) {
                        header += `${commonHeaderCellPart}"${col}">Stack</vscode-data-grid-cell>\n`;
                    } else if (key === 'Address') {
                        header += `${commonHeaderCellPart}"${col}">Thread</vscode-data-grid-cell>\n`;
                    } else if (key === 'Prio') {
                        header += `${commonHeaderCellPart}"${col}">Prio</vscode-data-grid-cell>\n`;
                    } else {
                        header += `${commonHeaderCellPart}"${col}"></vscode-data-grid-cell>\n`;
                    }
                    col++;
                }
                header += '  </vscode-data-grid-row>\n';

                col = 1;
                header += commonHeaderRowPart;
                for (const key of keys) {
                    const v = th[key];
                    const key2 = keys2[col - 1];
                    header += `${commonHeaderCellPart}"${col}">${key2}</vscode-data-grid-cell>\n`;
                    col++;
                }
                header += '  </vscode-data-grid-row>\n';
                table += header;
            }

            let col = 1;
            const running = (th['Status'] === 'RUNNING') ? 'running' : '';
            table += `  <vscode-data-grid-row class="${this.name}-row threads-row">\n`;
            for (const key of keys) {
                const v = th[key];
                let txt = v;
                if (key === 'Stack Start') {
                    txt = `<vscode-link class="threads-link-${makeOneWord(key)}" href="#">${v}</vscode-link>`;
                }
                const cls = `class="${this.name}-cell threads-cell threads-cell-${makeOneWord(key)} ${running}"`;
                table += `    <vscode-data-grid-cell ${cls} grid-column="${col}">${txt}</vscode-data-grid-cell>\n`;
                col++;
            }
            table += '  </vscode-data-grid-row>\n';
        }
        ret += table;
        ret += '</vscode-data-grid>\n';
        if (this.timeInfo) {
            ret += `<p>Data collected at ${this.timeInfo}</p>\n`;
        }

        console.log(ret);
        this.lastValidHtml = ret;
        return ret;
    }
}

function makeOneWord(s: string): string {
    return s.toLowerCase().replace(/\s+/g, '-');
}