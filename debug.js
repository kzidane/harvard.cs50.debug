define(function(require, exports, module) {
    "use strict";

    main.consumes = [
        "Plugin", "breakpoints", "c9", "commands", "dialog.question",
        "dialog.error", "debugger", "fs", "proc", "run", "run.gui", "settings",
        "util", "watcher"
    ];
    main.provides = ["harvard.cs50.debug"];
    return main;

    function main(options, imports, register) {
        var Plugin = imports.Plugin;
        var askQuestion = imports["dialog.question"].show;
        var breakpoints = imports.breakpoints;
        var c9 = imports.c9;
        var commands = imports.commands;
        var debug = imports.debugger;
        var fs = imports.fs;
        var proc = imports.proc;
        var run = imports.run;
        var rungui = imports["run.gui"];
        var showError = imports["dialog.error"].show;
        var settings = imports.settings;
        var util = imports.util;

        var _ = require("lodash");

        /***** Initialization *****/
        var plugin = new Plugin("Ajax.org", main.consumes);
        var process = {};
        var debugging = false;

        // delay execution of next debugging process if old is killed
        var subsequent = null;

        // PID of the shim
        const SETTING_PID="project/cs50/debug/@pid";

        // PID of the (hidden) proxy process that monitors shim
        const SETTING_PROXY="project/cs50/debug/@proxy";

        // name of the (hidden) proxy process
        const SETTING_NAME="project/cs50/debug/@name";

        const SETTING_RUNNER="project/cs50/debug/@runner";

        // path of debug50 script revision number
        const SETTING_VER="project/cs50/debug/@ver";

        // version of debug50 file
        var DEBUG_VER=15;

        /***** Methods *****/

        /**
         * Helper function for startDebugger to display errors.
         */
        function handleErr(proc, err) {
            showError(proc, "error:", err);
        }

        /**
         * Given a process object, ask the debugger to start debugging
         * it, and reconnecting the debugger to an existing running
         * procerss if necessary.
         */
        function startDebugging(pid, reconnect) {
            if (reconnect == undefined)
                reconnect = false;

            // kick off debugger
            debug.debug(process[pid], reconnect, function(err) {
                if (err) {
                    handleErr("Debug start", err);
                    return cleanState(pid);
                }

                // successfully opened debugger
                debugging = true;

                // store pid state for later use
                settings.set(SETTING_PID, pid);
                settings.set(SETTING_PROXY, process[pid].pid);
                settings.set(SETTING_NAME, process[pid].name);
                settings.set(SETTING_RUNNER, process[pid].runner.caption || process[pid].runner[0].caption);
            });
        }

        /**
         * Helper function to start the runner and kick off debug
         * process, saving state in event of reconnect.
         */
        function startProxy(cwd, pid, runner) {
            // start shim by sending debug50 the SIGUSR1 signal
            proc.spawn("kill", { args: ["-SIGUSR1", pid] }, function() {});

            // provide proxy process with pid to monitor
            const procOpts = {
                cwd: cwd,
                args: [pid.toString()],
                debug: true
            };

            // start proxy process and begin debugging if successful
            process[pid] = run.run(runner, procOpts, function(err) {
                if (err)
                    return handleErr("Proxy process run", err);

                startDebugging(pid);
            });
        }

        /**
         * Helper function to clean process and debugger state.
         */
        function cleanState(pid) {
            if (debugging)
                debug.stop();

            if (pid)
                delete process[pid];

            debugging = false;

            settings.set(SETTING_PID, null);
            settings.set(SETTING_NAME, null);
            settings.set(SETTING_PROXY, null);
            settings.set(SETTING_RUNNER, null);

            if (subsequent) {
                subsequent();
                subsequent = null;
            }
        }


        /**
         * Start a process that serves as a proxy for a GDB shim
         * already running on the command line. The proxy simply
         * monitors the shim process and is used by the debugger
         * API to determine if the process is still running.
         * Execute with:
         * `c9 exec startGDB; node ~/.c9/bin/c9gdbshim.js BIN ARGS`;
         *  c9 exec stopGDB`
         */
        function startDebugger(args, reconnect) {
            if (args.length != 3) {
                showError("Error: expected process PID and a runner!");
                return false;
            }

            // process pid passed by argument
            const pid = args[2];

            // set monitor name
            const runnerName = args[1] === "gdb" ?
                "GDBMonitor" : (args[1] === "ikp3db" ?
                    "IKP3DBMonitor" : null);

            if (!runnerName) {
                showError("Error: invalid debugger!");
                return false;
            }


            // fetch shell runner
            run.getRunner(runnerName, function(err, runner) {
                if (err)
                    return handleErr("Runner fetch", err);

                // make sure debugger isn't already running
                debug.checkAttached(function() {
                    // no cli process running
                    if (!debugging)
                        return startProxy(args[0], pid, runner);

                    // wait to startProxy until old has stopped
                    subsequent = startProxy.bind(this, args[0], pid, runner);
                }, function() {
                    // user cancelled, abort the debug50 call
                    proc.spawn("kill", { args: [pid] }, function() {});
                });
            });
        }

        /**
         * stopGDB
         * Stops and cleans a debug process started with startGDB.
         */
        function stopDebugger(args) {
            if (args.length != 2) {
                showError("Error: expected process PID!");
                return false;
            }

            // close debugger right away (waiting for proc to stop takes time)
            if (debugging)
                debug.stop();

            // process pid passed by argument
            const pid = args[1];

            // must only run if a process is running
            if (process[pid] === undefined)
                return false;

            // stop PID and clean up
            process[pid].stop(cleanState.bind(this, pid));
            return true;
        }

        /**
         * Check to see if we've saved a running process in the past.
         * Try to restore it and re-connect the debugger to it, if it
         * exists.
         */
        function restoreProcess() {
            const proxy = settings.getNumber(SETTING_PROXY);
            const pid = settings.getNumber(SETTING_PID);
            const name = settings.get(SETTING_NAME);
            const runnerName = settings.get(SETTING_RUNNER);

            if (!proxy || !pid || !name || !runnerName)
                return;

            // to rebuild process we need the runner
            run.getRunner(runnerName, function(err, runner) {
                if (err)
                    return cleanState(pid);

                // recover process from saved state
                process[pid] = run.restoreProcess({
                    pid: proxy,
                    name: name,
                    runner: [runner],
                    running: run.STARTED
                });

                // reconnect the debugger
                startDebugging(pid, true);
            });
        }

        /**
         * Callback to be called after writing debug50
         *
         * @callback cb
         * @param err an error in case of failure
         * @param path debug50's path
         */

        /**
         * Writes and updates debug50 script when should
         *
         * @param [cb] a callback to call after debug50's been written
         */
        function writeDebug50(cb) {
            // debug50's path on the system
            var path = "~/.cs50/bin/debug50";

            // ensure debug50 doesn't exist
            fs.exists(path, function(exists) {
                // fetch the currently set version
                var ver = settings.getNumber(SETTING_VER);

                // write debug50 when should
                if (!exists || isNaN(ver) || ver < DEBUG_VER) {
                    // retrive debug50's contents
                    var content = require("text!./bin/debug50");

                    // write debug50
                    fs.writeFile(path, content, function(err){
                        if (err) {
                            console.error(err);
                            return _.isFunction(cb) && cb(err);
                        }

                        // chmod debug50
                        fs.chmod(path, 755, function(err){
                            if (err) {
                                console.error(err);
                                return _.isFunction(cb) && cb(err);
                            }

                            // set or update version
                            settings.set(SETTING_VER, DEBUG_VER);

                            // call the callback, if given
                            _.isFunction(cb) && cb(null, path);
                        });
                    });
                }
                else if (exists && _.isFunction(cb)) {
                    cb(null, path);
                }
            });
        }

        function load() {
            // don't allow users to see "Save Runner?" dialog
            settings.set("user/output/nosavequestion", "true");

            // Monitors a shim started on the command line.
            run.addRunner("GDBMonitor", {
                caption: "GDBMonitor",
                script: ['while kill -0 $args ; do sleep 1; done'],
                debugger: "gdb",
                $debugDefaultState: true,
                retryCount: 100,
                retryInterval: 300,
                socketpath: "/home/ubuntu/.c9/gdbdebugger.socket"
            }, run);

            // create commands that can be called from `c9 exec`
            commands.addCommand({
                name: "startDebugger",
                hint: "Kickstart debugger from CLI",
                group: "Run & Debug",
                exec: startDebugger
            }, plugin);

            commands.addCommand({
                name: "stopDebugger",
                hint: "Stop debugger started from CLI",
                group: "Run & Debug",
                exec: stopDebugger
            }, plugin);

            commands.addCommand({
                name: "gdb50forcestop",
                hint: "Force-stop GDB debugger",
                group: "Run & Debug",
                exec: function() {
                    askQuestion(
                        "Stop debugging", "",
                        "Are you sure you want to force-stop the debugger?",

                        // Yes
                        function() {
                            process.forEach(function(r, pid) {
                                 stopGDB([null, pid]);
                            });
                        },

                        // No
                        function() {},

                        // hide "All" and "Cancel" buttons
                        {
                            all: false,
                            cancel: false
                        }
                    );
                }
            }, plugin);

            commands.addCommand({
                name: "breakpoint_set",
                hint: "Check if source file has at least a breakpoint",
                group: "Run & Debug",
                exec: function(args) {
                    if (args.length !== 2)
                        return false;

                    // check if at least one breakpoint is set in the source file provided
                    return breakpoints.breakpoints.some(function(breakpoint) {

                        // slash at the beginning means ~/workspace/
                        return breakpoint.path.replace(/^\//, c9.workspaceDir + "/").replace(/^~/, c9.home) == args[1];
                    });
                }
            }, plugin);

            run.addRunner("IKP3DBMonitor", {
                caption: "IKP3DBMonitor",
                script: ['while kill -0 $args ; do sleep 1; done'],
                debugger: "pythondebug",
                debugport: 15471,
                maxdepth: 50,
                $debugDefaultState: true,
                retryCount: 100,
                retryInterval: 300,
            }, run);

            writeDebug50();

            // try to restore state if a running process
            restoreProcess();
        }

        /***** Lifecycle *****/

        plugin.on("load", function() {
            load();
        });
        plugin.on("unload", function() {
            process = null;
            subsequent = null;
            debugging = false;
        });

        /***** Register and define API *****/

        plugin.freezePublicAPI({});

        register(null, {
            "harvard.cs50.debug": plugin
        });
    }
});
