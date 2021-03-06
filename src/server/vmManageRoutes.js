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

const createId = require("./createId");
const koaRouter = require("koa-router");
const VM = require("./VM");
const co = require("co");
const url = require("url");
const parse = require("co-body");
const basicAuth = require("basic-auth");

const addRunningVM = co.wrap(function *(application, vmNameOrId) {
    const vboxClient = application.vboxClient;
    const vm = new VM();
    try {
        vm.vboxMachine = yield application.vboxObject.findMachine(vmNameOrId);
        const vmState = yield vm.vboxMachine.getState();
        if (vmState !== "Running") {
            throw new Error("The virtual machine is not running.");
        }
        vm.vboxSession = yield vboxClient.getSessionObject(application.vboxObject);
        yield vm.vboxMachine.lockMachine(vm.vboxSession, "Shared");
        yield vm.fillConsole();
    } catch (e) {
        yield vm.close();
        throw e;
    }
    return vm;
});

const cloneAndRunVM = co.wrap(function *(application, vmNameOrId, clonedName, snapshot) {
    const vboxClient = application.vboxClient;
    const vm = new VM();
    vm.close = vm.stopAndDelete;
    try {
        let originalMachine = yield application.vboxObject.findMachine(vmNameOrId);
        if (snapshot) {
            const snapshotObject = yield originalMachine.findSnapshot(snapshot);
            originalMachine = yield snapshotObject.getMachine();
        }
        vm.vboxMachine = yield application.vboxObject.createMachine(null, clonedName);
        const cloneProgress = yield originalMachine.cloneTo(vm.vboxMachine, "MachineState", ["Link"]);
        yield cloneProgress.waitForCompletion(-1);
        yield application.vboxObject.registerMachine(vm.vboxMachine);
        vm.vboxSession = yield vboxClient.getSessionObject(application.vboxObject);
        const startProgress = yield vm.vboxMachine.launchVMProcess(vm.vboxSession, "headless");
        yield startProgress.waitForCompletion(-1);
        yield vm.fillConsole(application, vm);
    } catch (e) {
        yield vm.close();
        throw e;
    }
    return vm;
});

const addVM = co.wrap(function * (ctx) {
    const application = ctx.application;
    const vms = application.vms;
    const vmId = createId();
    const body = yield parse.json(ctx);
    if (body.clone) {
        console.log(`/vm/${vmId}/clone ${body.clone} (${body.snapshot || "snapshot not specified"})`);
        vms[vmId] = yield cloneAndRunVM(application, body.clone, vmId, body.snapshot);
    } else if (body.connect) {
        console.log(`/vm/${vmId}/connect ${body.connect}`);
        vms[vmId] = yield addRunningVM(application, body.connect);
    }
    ctx.status = 200;
    const baseURL = url.format({
        protocol: ctx.protocol,
        host: ctx.host,
        pathname: `/vm/${vmId}`
    });
    ctx.body = {
        robotjs: `${baseURL}/robot.js`,
        run:  `${baseURL}/run`,
        close: `${baseURL}/close`
    };
});

const removeVM = co.wrap(function * (ctx) {
    const vm = ctx.vmRef;
    if (vm) {
        console.log(ctx.path);
        const application = ctx.application;
        delete application.vms[ctx.vmId];
        yield vm.close();
        ctx.status = 200;
    }
});

const runCommandInVM = co.wrap(function * (ctx) {
    const vm = ctx.vmRef;
    if (!vm) {
        ctx.status = 404;
        return;
    }
    const body = yield parse.json(ctx);
    console.log(`${ctx.path} ${body.commandLine.join(" ")}`);
    ctx.body = yield vm.runProcess(body);
    ctx.status = 200;
});

const vmParam = function (vm, ctx, next) {
    ctx.vmId = vm;
    ctx.vmRef = ctx.application.vms[vm];
    return next();
};

const checkAuth = function (ctx, next) {
    const config = ctx.application.config;
    const username = config.username;
    const password = config.password;
    if (username || password) {
        const credentials = basicAuth(ctx.req);
        if (!credentials || (username != null && credentials.name !== username) || (password != null && credentials.pass !== password)) {
            ctx.status = 401;
            ctx.set("WWW-Authenticate", "Basic realm=\"protected area\"");
            return;
        }
    }
    return next();
};

const errorHandling = co.wrap(function * (ctx, next) {
    try {
        yield next();
    } catch (e) {
        ctx.status = e.status || 500;
        ctx.body = e.message;
    }
});

module.exports = function () {
    const router = koaRouter();

    router.param("vm", vmParam);
    router.use(errorHandling);
    router.post("/", checkAuth, addVM);
    router.post("/vm/:vm/run", runCommandInVM);
    router.post("/vm/:vm/close", removeVM);

    return router;
};

module.exports.addRunningVM = addRunningVM;
module.exports.cloneAndRunVM = cloneAndRunVM;
