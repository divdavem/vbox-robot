/*
 * Copyright 2015 Amadeus s.a.s.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *    http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
"use strict";

const co = require("co");

const url = require("url");
const koaRouter = require("koa-router");
const fs = require("fs");
const path = require("path");
const clientJS = fs.readFileSync(path.join(__dirname, "..", "..", "build", "robot.js"), "utf-8");
const promisify = require("pify");
const readFile = promisify(fs.readFile);
const commonHeaders = {
    "Cache-Control": "no-cache, no-store, must-revalidate",
    "Pragma": "no-cache",
    "Expires": "Tue, 01 Jan 1970 00:00:00 GMT"
};
const BUTTON1_MASK = 16;
const BUTTON2_MASK = 8;
const BUTTON3_MASK = 4;
const wait = require("../wait");
const calibrate = require("./calibration");
const checkInt = require("./checkInt");
const keyboardLayout = require("./keyboard/layout");
const stringToScancodes = require("./keyboard/stringToScancodes");

const checkArray = function (data) {
    if (!Array.isArray(data)) {
        throw new Error(`Expected an array: ${data}`);
    }
    return data;
};

const checkString = function (data) {
    return String(data);
};

const robotHTML = co.wrap(function * (ctx){
    if (! ctx.path.endsWith("/")) {
        ctx.redirect(`${ctx.path}/`);
        return;
    }
    ctx.set(commonHeaders);
    ctx.type = "html";
    ctx.body = yield readFile(path.join(__dirname,"..","browser", "index.html"));
});

const robotJS = co.wrap(function * (ctx){
    ctx.set(commonHeaders);
    ctx.type = "js";
    const apiRootURL = url.format({
        protocol: ctx.protocol,
        host: ctx.host,
        pathname: `/vm/${ctx.params.vm}/api`
    });
    ctx.body = clientJS.replace("SERVER_URL", function () {
        return JSON.stringify(apiRootURL);
    });
});

const callbackCheck = /^[\[\]A-Za-z0-9_\.\$]{1,50}$/;
const apiWrapper = co.wrap(function * (ctx, next) {
    let success = true;
    try {
        ctx.data = JSON.parse(ctx.query.data || null);
        yield next();
    } catch (e) {
        success = false;
        ctx.body = `${e} when executing ${ctx.path} with data ${ctx.query.data}`;
    }
    ctx.set(commonHeaders);
    ctx.body = JSON.stringify({
        success: success,
        result: ctx.body
    });
    console.log(`${ctx.path}?data=${ctx.query.data} => ${ctx.body}`);
    // JSON-P:
    const callback = ctx.query.callback;
    if (callback && callbackCheck.test(callback)) {
        ctx.type = "js";
        ctx.body = `/**/ ${callback}(${ctx.body});`;
    } else {
        ctx.type = "json";
    }
});

const mouseMove = co.wrap(function * (ctx) {
    yield ctx.vm.mouseMove(checkInt(ctx.data[0]), checkInt(ctx.data[1]));
});

const smoothMouseMove = co.wrap(function * (ctx){
    const data = ctx.data;
    const fromX = checkInt(data[0]);
    const fromY = checkInt(data[1]);
    const toX = checkInt(data[2]);
    const toY = checkInt(data[3]);
    const duration = checkInt(data[4]);
    yield ctx.vm.mouseMove(fromX, fromY);
    let currentTime = Date.now();
    const endTime = currentTime + duration;
    while (currentTime < endTime) {
        const howCloseToEnd = (endTime - currentTime) / duration;
        yield ctx.vm.mouseMove(Math.round(howCloseToEnd * fromX + (1 - howCloseToEnd) * toX), Math.round(howCloseToEnd * fromY + (1 - howCloseToEnd) * toY));
        yield wait(50);
        currentTime = Date.now();
    }
    yield ctx.vm.mouseMove(toX, toY);
});

const mouseButtonEvent = co.wrap(function * (buttonChangeFn, ctx){
    const buttons = checkInt(ctx.data[0]);
    ctx.vm.mouseButtonsState = buttonChangeFn(buttons, ctx.vm.mouseButtonsState);
    yield ctx.vm.vboxMouse.putMouseEvent(0, 0, 0, 0, ctx.vm.mouseButtonsState);
});

const mousePressButtonChange = function (buttons, mouseButtonsState) {
    if (buttons & BUTTON1_MASK) {
        mouseButtonsState |= 0x01;
    }
    if (buttons & BUTTON2_MASK) {
        mouseButtonsState |= 0x02;
    }
    if (buttons & BUTTON3_MASK) {
        mouseButtonsState |= 0x04;
    }
    return mouseButtonsState;
};
const mousePress = mouseButtonEvent.bind(null, mousePressButtonChange);

const mouseReleaseButtonChange = function (buttons, mouseButtonsState) {
    if (buttons & BUTTON1_MASK) {
        mouseButtonsState &= ~0x01;
    }
    if (buttons & BUTTON2_MASK) {
        mouseButtonsState &= ~0x02;
    }
    if (buttons & BUTTON3_MASK) {
        mouseButtonsState &= ~0x04;
    }
    return mouseButtonsState;
};
const mouseRelease = mouseButtonEvent.bind(null, mouseReleaseButtonChange);

const mouseWheel = co.wrap(function * (ctx){
    const vm = ctx.vm;
    yield vm.vboxMouse.putMouseEvent(0, 0, checkInt(ctx.data[0]), 0, vm.mouseButtonsState);
});

const keyboardSendScancodes = co.wrap(function * (ctx) {
    const scancodes = checkArray(ctx.data[0]);
    yield ctx.vm.vboxKeyboard.putScancodes(scancodes);
});

const createKeyEventHandler = function (eventName) {
    const curLayout = keyboardLayout[eventName];
    return co.wrap(function * (ctx) {
        const keyCode = checkInt(ctx.data[0]);
        const scancodes = curLayout[keyCode];
        if (!scancodes) {
            throw new Error(`Unknown key code: ${keyCode}`);
        }
        yield ctx.vm.vboxKeyboard.putScancodes(scancodes);
    });
};

const type = co.wrap(function * (ctx) {
    const text = checkString(ctx.data[0]);
    const scancodes = stringToScancodes(text);
    yield ctx.vm.vboxKeyboard.putScancodes(scancodes);
});

const pause = co.wrap(function * (ctx) {
    const delay = checkInt(ctx.data[0]);
    yield wait(delay);
});

const actionsMap = {
    "mouseMove": mouseMove,
    "smoothMouseMove": smoothMouseMove,
    "mousePress": mousePress,
    "mouseRelease": mouseRelease,
    "mouseWheel": mouseWheel,
    "keyboardSendScancodes": keyboardSendScancodes,
    "keyPress": createKeyEventHandler("keyPress"),
    "keyRelease": createKeyEventHandler("keyRelease"),
    "calibrate": calibrate,
    "type": type,
    "pause": pause
};

const execute = co.wrap(function * (ctx) {
    const actions = checkArray(ctx.data[0]);
    for (let i = 0, l = actions.length; i < l; i++) {
        let curAction = actions[i];
        curAction = checkArray(curAction);
        const actionName = checkString(curAction[0]);
        const actionFn = actionsMap.hasOwnProperty(actionName) ? actionsMap[actionName] : null;
        if (!actionFn) {
            throw new Error(`Unknown action ${actionName}`);
        }
        ctx.data = curAction.slice(1);
        console.log(`/vm/${ctx.vmId} execute (${1+i}/${l}) ${actionName} ${JSON.stringify(ctx.data)}`);
        yield actionFn(ctx);
    }
});

const vmParam = function (vmId, ctx, next) {
    ctx.vm = ctx.application.vms[vmId];
    if (!ctx.vm) {
        ctx.status = 404;
        return;
    }
    ctx.vmId = vmId;
    return next();
};

module.exports = function () {
    const router = koaRouter();

    router.param("vm", vmParam);
    router.use("/vm/:vm/api", apiWrapper);
    router.get("/vm/:vm/robot.js", robotJS);
    router.get("/vm/:vm/", robotHTML);
    router.get("/vm/:vm/api/execute", execute);

    return router;
};
