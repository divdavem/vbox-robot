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

var normalizeCallback = require("./normalizeCallback");
var request = require("./request");
var keyboardLayout = require("./keyboard/layout");
var stringToScancodes = require("./keyboard/stringToScancodes");

var actions = exports.actions = {};

var executeActions = exports.executeActions = function (actions, callback) {
    request("executeActions", [actions], normalizeCallback(callback));
};

var registerAction = function (name, argsNumber, action) {
    actions[name] = function () {
        try {
            return action.apply(this, arguments);
        } catch (e) {
            return ["error", e + ""];
        }
    };
    exports[name] = function () {
        var callback = normalizeCallback(arguments[argsNumber]);
        executeActions([actions[name].apply(actions, slice.call(arguments, 0, argsNumber))], function (result) {
            if (result.success) {
                result = result.result[0];
            }
            callback(result);
        });
    };
};

var slice = Array.prototype.slice;
var registerSimpleAction = function (name, argsNumber) {
    registerAction(name, argsNumber, function () {
        const res = slice.call(arguments, 0, argsNumber);
        res.unshift(name);
        return res;
    });
};

registerSimpleAction("mouseMove", 2);
registerSimpleAction("smoothMouseMove", 5);
registerSimpleAction("mousePress", 1);
registerSimpleAction("mouseRelease", 1);
registerSimpleAction("mouseWheel", 1);
registerSimpleAction("calibrate", 2);
registerSimpleAction("keyboardSendScancodes", 1);
registerSimpleAction("pause", 1);

exports.getOffset = function (callback) {
    callback = normalizeCallback(callback);
    var div = document.createElement("div");
    var border = 30;
    div.style.cssText = "display:block;position:absolute;background-color:rgb(255, 0, 0);border:" + border
            + "px solid rgb(100, 100, 100);left:0px;top:0px;right:0px;bottom:0px;cursor:none;z-index:999999;";
    document.body.appendChild(div);
    // wait some time for the browser to display the element
    setTimeout(function () {
        exports.calibrate(div.offsetWidth - 2 * border, div.offsetHeight - 2 * border, function (response) {
            div.parentNode.removeChild(div);
            if (response.success) {
                var result = response.result;
                response.result = {
                    x : result.x - border,
                    y : result.y - border
                };
            }
            callback(response);
        });
    }, 200);
};

var createKeyEventFunction = function (eventName) {
    var curLayout = keyboardLayout[eventName];
    registerAction(eventName, 1, function (keyCode) {
        var scancodes = curLayout[keyCode];
        if (scancodes) {
            return ["keyboardSendScancodes", scancodes];
        } else {
            return ["error", "Unknown key code: " + keyCode];
        }
    });
};

createKeyEventFunction("keyPress");
createKeyEventFunction("keyRelease");

registerAction("type", 1, function (text) {
    return ["keyboardSendScancodes", stringToScancodes(text)];
});
