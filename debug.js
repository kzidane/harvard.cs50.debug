define(function(require, exports, module) {
    "use strict";

    main.consumes = [
        "Plugin", "commands", "dialog.error", "debugger", "fs", "proc", "run",
        "run.gui", "settings", "util", "watcher"
    ];
    main.provides = ["harvard.cs50.debug"];
    return main;

    function main(options, imports, register) {
        var Plugin = imports.Plugin;
        var commands = imports.commands;
        var debug = imports.debugger;
        var fs = imports.fs;
        var proc = imports.proc;
        var run = imports.run;
        var rungui = imports["run.gui"];
        var showError = imports["dialog.error"].show;
        var settings = imports.settings;
        var util = imports.util;
        var watcher = imports.watcher;

        var _ = require("lodash");

        /***** Initialization *****/
        var plugin = new Plugin("Ajax.org", main.consumes);
        var process = {};
        var debugging = false;

        // delay execution of next debugging process if old is killed
        var subsequent = null;

        // PID of the shim
        var SETTING_PID="project/cs50/debug/@pid";

        // PID of the (hidden) proxy process that monitors shim
        var SETTING_PROXY="project/cs50/debug/@proxy";

        // name of the (hidden) proxy process
        var SETTING_NAME="project/cs50/debug/@name";

        // path of debug50 script revision number
        var SETTING_VER="project/cs50/debug/@ver";

        // version of debug50 file
        var DEBUG_VER=9;

        /***** Methods *****/

        /**
         * Helper function for startdebug50 to display errors.
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
            var procOpts = {
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

            if (process.hasOwnProperty(pid))
                delete process[pid];

            debugging = false;

            settings.set(SETTING_PID, null);
            settings.set(SETTING_NAME, null);
            settings.set(SETTING_PROXY, null);

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
         * `c9 exec startdebug50; node ~/.c9/bin/c9gdbshim.js BIN ARGS`;
         *  c9 exec stopdebug50`
         */
        function startdebug50(args, reconnect) {
            if (args.length != 2) {
                showError("Error: expected process PID!");
                return false;
            }

            // process pid passed by argument
            var pid = args[1];

            // fetch shell runner
            run.getRunner("Shell50", function(err, runner) {
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
         * Stops and cleans a debug process started with startdebug50.
         */
        function stopdebug50(args) {
            if (args && args.length > 2) {
                console.error("Usage: c9 exec stopdebug50 [PID]");
                return false;
            }

            // close debugger right away (waiting for proc to stop takes time)
            if (debugging)
                debug.stop();

            // allow force-stopping any debugging process started with startdebug50
            if (!args || args.length < 2) {
                for (var pid in process)
                    process[pid].stop();

                return;
            }

            // process pid passed by argument
            var pid = args[1];

            // must only run if a process is running
            if (process[pid] === undefined)
                return false;

            // stop PID and clean up
            process[pid].stop(cleanState.bind(this, pid));
        }

        /**
         * Check to see if we've saved a running process in the past.
         * Try to restore it and re-connect the debugger to it, if it
         * exists.
         */
        function restoreProcess() {
            var proxy = settings.getNumber(SETTING_PROXY);
            var pid = settings.getNumber(SETTING_PID);
            var name = settings.get(SETTING_NAME);

            if (!proxy || !pid || !name)
                return;

            // to rebuild process we need the runner
            run.getRunner("Shell50", function(err, runner) {
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
            var path = "~/bin/debug50";

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
            run.addRunner("Shell50", {
                caption: "Shell50",
                script: ['while kill -0 $args ; do sleep 1; done'],
                debugger: "gdb",
                $debugDefaultState: true,
                retryCount: 100,
                retryInterval: 300,
                socketpath: "/home/ubuntu/.c9/gdbdebugger.socket"
            }, run);

            // create commands that can be called from `c9 exec`
            commands.addCommand({
                name: "startdebug50",
                hint: "Kickstart GDB debugger from CLI",
                group: "Run & Debug",
                exec: startdebug50
            }, plugin);

            commands.addCommand({
                name: "stopdebug50",
                hint: "Stop GDB debugger started from CLI",
                group: "Run & Debug",
                exec: stopdebug50
            }, plugin);

            // write debug50 when should
            writeDebug50(function watchDebug50(err, path) {
                if (err) return;

                // watch debug50
                watcher.watch(path);

                // write debug50 when deleted
                watcher.once("delete", function(e) {
                    if (e.path === path)
                        writeDebug50(watchDebug50);
                });
            });

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
