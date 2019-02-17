const Promise = require('bluebird');
const fs = Promise.promisifyAll(require('fs'));
const path = require('path');
const async = require('async');
const mkdirp = require('mkdirp');
require('colors');
const pm2 = require('pm2');
// const pm2cst = require('pm2/constants.js');
// const pm2prepare = require('pm2/lib/Common.js').prepareAppConf;
    // Client is pm2's RPC daemon, we have to use it to get
    // some custom behavior that is not exposed by pm2's CLI.
let Client = pm2.Client;
const exec = require('await-exec');
const Emitter = require('events').EventEmitter;
const debug = require('debug')('api');

const conf = require('./conf');
const ERRORS = require('./errors');
const formatter = require('./formatter');
const hookTemplate = fs.readFileSync(__dirname + '/../hooks/post-receive', 'utf-8');

// Load config data
const globalConfigPath = conf.path;
const webInterfaceId = conf.webId;
let globalConfig = readJSON(globalConfigPath);

upgradeConf();

// If env var is present, overwrite root dir
// mostly for testing.
if (process.env.POD_ROOT_DIR) globalConfig.root = process.env.POD_ROOT_DIR;

// create default folders
if (!fs.existsSync(globalConfig.root)) mkdirp.sync(globalConfig.root);
if (!fs.existsSync(globalConfig.root + '/apps')) fs.mkdirSync(globalConfig.root + '/apps');
if (!fs.existsSync(globalConfig.root + '/repos')) fs.mkdirSync(globalConfig.root + '/repos');

// The api is an emitter
const api = new Emitter();

// init and connect to pm2
//pm2.pm2Init()
pm2.connect(function () {
    api.emit('ready');
    Client = pm2.Client;
});

api.version = require('../package.json').version;

api.createApp = async function (appname, options, output) {

    const msgs = [];

    if (typeof options === 'function') {
        output = options;
        options = null;
    }

    if (globalConfig.apps[appname] || appname === webInterfaceId) {
        return abort(ERRORS.EXISTS, output, { appname: appname });
    }

    const paths = getAppPaths(appname);
    
    const opts = {};
            // merge options
    if (options) {
        for (const o in options) {
            opts[o] = options[o];
        }
    }
    globalConfig.apps[appname] = opts;
    const data = JSON.stringify(globalConfig, null, 4);
    await fs.writeFileAsync(globalConfigPath, data); 
    msgs.push('updated config.');
    if (options && options.remote) {
        await createRemoteApp(paths, options.remote, output);
    } else {
        await createAppRepo(paths, output);
    }
    async.parallel(,
        function (err, msgs) {
            const repoMsgs = msgs.pop();
            msgs = msgs.concat(repoMsgs);
            return output(err, msgs, api.getAppInfo(appname));
        });
};

api.removeApp = function (appname, callback) {

    if (appname === webInterfaceId) {
        return abort(ERRORS.WEB, callback);
    }

    const app = api.getAppInfo(appname);
    if (!app) {
        return abort(ERRORS.NOT_FOUND, callback, { appname: appname });
    }

    api.stopApp(appname, function (err) {
        if (!err || /is not running/.test(err.toString())) {
            async.parallel([
                function (done) {
                    // remove files
                    exec('rm -rf ' +
                        app.repoPath + ' ' +
                        app.workPath,
                        done
                    );
                },
                function (done) {
                    // rewrite config
                    delete globalConfig.apps[appname];
                    const data = JSON.stringify(globalConfig, null, 4);
                    fs.writeFile(globalConfigPath, data, done);
                }
            ],
                function (err) {
                    if (err) return callback(err);
                    return callback(null, 'deleted app: ' + appname.yellow);
                });
        } else {
            return callback(err);
        }
    });

};

api.startApp = function (appname, callback) {

    const app = api.getAppInfo(appname);
    if (!app) {
        return abort(ERRORS.NOT_FOUND, callback, { appname: appname });
    }

    debug('checking if app main script exists...');
    fs.exists(app.script, function (exists) {
        if (!exists) {
            return abort(ERRORS.NO_SCRIPT, callback, { appname: appname, script: app.script });
        }
        debug('checking if app is already running...');
        Client.executeRemote('getMonitorData', {}, function (err, list) {
            if (err) return callback(err);
            const runningProcs = findInList(appname, list);
            if (!runningProcs) {
                debug('attempting to start app...');
                pm2.start(prepareConfig(app), function (err) {
                    if (err) return callback(err);
                    return callback(null, appname.yellow + ' running on ' + (app.port || 'unknown port'));
                });
            } else {
                return abort(ERRORS.RUNNING, callback, { appname: appname });
            }
        });
    });
};

api.startAllApps = function (callback) {
    async.map(
        Object.keys(globalConfig.apps),
        api.startApp,
        callback
    );
};

api.stopApp = function (appname, callback) {

    const app = api.getAppInfo(appname);
    if (!app) {
        return abort(ERRORS.NOT_FOUND, callback, { appname: appname });
    }

    Client.executeRemote('getMonitorData', {}, function (err, list) {
        if (err) return callback(err);
        const runningProcs = findInList(appname, list);
        if (!runningProcs) {
            return callback(null, appname.yellow + ' is not running.');
        } else {
            async.map(runningProcs, function (proc, done) {
                Client.executeRemote('stopProcessId', proc.pm_id, function (err) {
                    if (err) return done(err);
                    Client.executeRemote('deleteProcessId', proc.pm_id, done);
                });
            }, function (err) {
                if (err) return callback(err);
                const l = runningProcs.length;
                return callback(
                    null,
                    appname.yellow + ' stopped.' +
                    (l > 1 ? (' (' + l + ' instances)').grey : '')
                );
            });
        }
    });
};

api.stopAllApps = function (callback) {
    // only stop ones in the config
    async.map(
        Object.keys(globalConfig.apps),
        api.stopApp,
        callback
    );
};

api.restartApp = function (appname, callback) {

    const app = api.getAppInfo(appname);
    if (!app) {
        return abort(ERRORS.NOT_FOUND, callback, { appname: appname });
    }

    Client.executeRemote('getMonitorData', {}, function (err, list) {
        if (err) return callback(err);
        const runningProcs = findInList(appname, list);
        if (!runningProcs) {
            return abort(ERRORS.NOT_RUNNING, callback, { appname: appname });
        } else {
            async.map(runningProcs, restart, function (err) {
                if (err) return callback(err);
                const l = runningProcs.length;
                return callback(
                    null,
                    appname.yellow + ' restarted.' +
                    (l > 1 ? (' (' + l + ' instances)').grey : '')
                );
            });
        }
    });
};

api.restartAllApps = function (callback) {
    Client.executeRemote('getMonitorData', {}, function (err, list) {
        if (err) return callback(err);
        const runningProcs = [];
        list.forEach(function (proc) {
            if (proc.pm2_env.name in globalConfig.apps) {
                runningProcs.push(proc);
            }
        });
        async.map(runningProcs, restart, function (err, msgs) {
            callback(err, msgs.map(function (msg) {
                return 'instance of ' + msg;
            }));
        });
    });
};

api.listApps = function (callback) {
    const appList = Object.keys(globalConfig.apps);
    if (!appList.length) {
        return process.nextTick(function () {
            return callback(null, []);
        });
    }
    Client.executeRemote('getMonitorData', {}, function (err, list) {
        if (err) return callback(err);
        return callback(null, appList.map(function (appname) {
            const app = api.getAppInfo(appname);
            app.instances = findInList(appname, list);
            app.broken = isBroken(app);
            return formatter.format(app);
        }));
    });
};

api.prune = function (callback) {
    const appList = Object.keys(globalConfig.apps),
        pruned = [];
    async.parallel([
        // clean root dir
        function (done) {
            fs.readdir(globalConfig.root, function (err, files) {
                if (err) return callback(err);
                async.map(files, function (f, next) {
                    if (f !== 'apps' && f !== 'repos') {
                        f = globalConfig.root + '/' + f;
                        pruned.push(f);
                        removeFile(f, next);
                    } else {
                        next();
                    }
                }, done);
            });
        },
        // clean apps dir
        function (done) {
            fs.readdir(globalConfig.root + '/apps', function (err, files) {
                if (err) return callback(err);
                async.map(files, function (f, next) {
                    if (appList.indexOf(f) < 0) {
                        f = globalConfig.root + '/apps/' + f;
                        pruned.push(f);
                        removeFile(f, next);
                    } else {
                        next();
                    }
                }, done);
            });
        },
        // clean repos dir
        function (done) {
            fs.readdir(globalConfig.root + '/repos', function (err, files) {
                if (err) return callback(err);
                async.map(files, function (f, next) {
                    const base = f.replace('.git', '');
                    if (appList.indexOf(base) < 0 || f.indexOf('.git') === -1) {
                        f = globalConfig.root + '/repos/' + f;
                        pruned.push(f);
                        removeFile(f, next);
                    } else {
                        next();
                    }
                }, done);
            });
        }
    ], function (err) {
        const msg = pruned.length
            ? 'pruned:\n' + pruned.join('\n').grey
            : 'root directory is clean.';
        return callback(err, msg);
    });
};

api.updateHooks = function (callback) {
    const appList = Object.keys(globalConfig.apps),
        updated = [];
    async.map(appList, function (app, next) {
        const info = getAppPaths(app);
        createHook(info, function (err) {
            if (!err) updated.push(info.name);
            next(err);
        });
    }, function (err) {
        return callback(err, 'updated hooks for:\n' + updated.join('\n').yellow);
    });
};

api.getAppInfo = function (appName) {
    if (appName === webInterfaceId) {
        return webConfig();
    }
    const info = getAppPaths(appName);
    info.config = globalConfig.apps[appName];
    if (!info.config) return;
    info.script = path.resolve(info.workPath, getAppMainScript(info.workPath, appName) || globalConfig.default_script);
    info.port = info.config.port || sniffPort(info.script) || null;
    return info;
};

api.getConfig = function () {
    return globalConfig;
};

api.reloadConfig = function () {
    globalConfig = readJSON(globalConfigPath);
    return globalConfig;
};

api.proxy = function () {
    return Client.executeRemote.apply(Client, arguments);
};

// helpers

function restart(app, callback) {
    Client.executeRemote('restartProcessId', { id: app.pm_id }, function (err) {
        if (err) return callback(err);
        return callback(null, app.pm2_env.name.yellow + ' restarted');
    });
}

function getAppPaths(app) {
    return {
        name: app,
        repoPath: globalConfig.root + '/repos/' + app + '.git',
        workPath: globalConfig.root + '/apps/' + app
    };
}

async function createAppRepo(info, done) {
    try {
        const msgs = [];
        await fs.mkdirAsync(info.repoPath);
        await exec(`git --git-dir ${info.repoPath} --bare init`);
        msgs.push(`created bare repo at ${info.repoPath.yellow}`);
        await createHook(info);
        msgs.push('created post-receive hook.');
        await exec(`git clone ${info.repoPath} "${info.workPath}"`);    
        msgs.push(`created empty working copy at ${info.workPath.yellow}`);
        done(null, msgs);
    } catch (err) {
        done(err);
    }
}

async function createRemoteApp(info, remote, done) {
    try {
        remote = expandRemote(remote);
        await exec(`git clone ${remote} "${info.workPath}"`);
        done(null, [
            'created remote app at ' + info.workPath.yellow,
            'tracking remote: ' + remote.cyan
        ]);
    } catch (err) {
        done(err);
    }
}

function expandRemote(remote) {
    const m = remote.match(/^([\w-_]+)\/([\w-_]+)$/);
    return m
        ? 'https://github.com/' + m[1] + '/' + m[2] + '.git'
        : remote;
}

async function createHook(info) {
    const hookPath = info.repoPath + '/hooks/post-receive';
    const data = hookTemplate
                .replace(/\{\{pod_dir\}\}/g, globalConfig.root)
                .replace(/\{\{app\}\}/g, info.name);
    await fs.writeFileAsync(hookPath, data);
    await fs.chmodAsync(hookPath, '0777');
}

function findInList(appname, list) {
    if (!list || !list.length) return false;
    const ret = [];
    let proc;
    for (let i = 0, j = list.length; i < j; i++) {
        proc = list[i];
        if (
            proc.pm2_env.status !== 'stopped' &&
            proc.pm2_env.name === appname
        ) {
            ret.push(list[i]);
        }
    }
    return ret.length > 0 ? ret : null;
}

function getAppMainScript(workPath, appname) {
    const pkg = readJSON(workPath + '/package.json');
    let main;

    if (globalConfig.apps[appname].script) {
        main = globalConfig.apps[appname].script;
    } else if (pkg && pkg.main) {
        main = pkg.main;
    }

    if (main) {
        if (/\.js$/.test(main)) {
            return main;
        } else {
            const mainPath = path.resolve(workPath, main);
            if (fs.existsSync(mainPath)) {
                return fs.statSync(mainPath).isDirectory()
                    ? main + '/index.js'
                    : main;
            } else {
                return main + '.js';
            }
        }
    }
}

function readJSON(file) {
    if (!fs.existsSync(file)) {
        return null;
    } else {
        return JSON.parse(fs.readFileSync(file, 'utf-8'));
    }
}

function sniffPort(script) {
    if (fs.existsSync(script)) {
        // sniff port
        const content = fs.readFileSync(script, 'utf-8');
        let portMatch = content.match(/\.listen\(\D*(\d\d\d\d\d?)\D*\)/);

        if (!portMatch) {
            const portVariableMatch = content.match(/\.listen\(\s*([a-zA-Z_$]+)\s*/);

            if (portVariableMatch) {
                portMatch = content.match(new RegExp(portVariableMatch[1] + '\\s*=\\D*(\\d\\d\\d\\d\\d?)\\D'));
            }
        }

        return portMatch ? portMatch[1] : null;
    }
}

function isBroken(app) {
    return app.name !== webInterfaceId &&
        (
            (!app.config.remote && !fs.existsSync(app.repoPath)) ||
            !fs.existsSync(app.workPath)
        );
}

function removeFile(f, cb) {
    const isDir = fs.statSync(f).isDirectory();
    fs[isDir ? 'rmdir' : 'unlink'](f, cb);
}

function webConfig() {
    const p = path.resolve(__dirname, '../web');
    return {
        name: webInterfaceId,
        workPath: p,
        config: globalConfig.web,
        script: p + '/app.js',
        port: globalConfig.web.port || 19999
    };
}

function prepareConfig(appInfo) {

    const conf = {
        name: appInfo.name,
        script: appInfo.script,
        env: {
            NODE_ENV: appInfo.config.node_env || globalConfig.node_env || 'development',
            PORT: appInfo.config.port
        }
    };

    // copy other options and pass it to pm2
    for (var o in appInfo.config) {
        if (
            o !== 'port' &&
            o !== 'node_env' &&
            o !== 'remote' &&
            o !== 'username' &&
            o !== 'password' &&
            o !== 'jsonp'
        ) {
            conf[o] = appInfo.config[o];
        }
    }

    for (o in globalConfig.env) {
        conf.env[o] = globalConfig.env[o];
    }

    // constraints, fallback to global config
    conf.min_uptime = conf.min_uptime || globalConfig.min_uptime || undefined;
    conf.max_restarts = conf.max_restarts || globalConfig.max_restarts || undefined;

    return conf;
}

function abort(e, callback, data) {
    let msg = e.msg;
    if (data) {
        msg = msg.replace(/{{(.+?)}}/g, function (m, p1) {
            return data[p1] || '';
        });
    }
    const err = new Error(msg);
    err.code = e.code;
    return process.nextTick(function () {
        return callback(err);
    });
}

function upgradeConf() {
    if (
        globalConfig.web &&
        globalConfig.node_env &&
        globalConfig.default_script
    ) return;

    if (!globalConfig.web) globalConfig.web = {};
    const fieldsToConvert = {
        'nodeEnv': 'node_env',
        'defaultScript': 'default_script',
        'fileOutput': 'out_file',
        'fileError': 'error_file',
        'pidFile': 'pid_file',
        'minUptime': 'min_uptime',
        'maxRestarts': 'max_restarts'
    };
    convert(globalConfig);
    fs.writeFile(globalConfigPath, JSON.stringify(globalConfig, null, 4));

    function convert(conf) {
        for (const key in conf) {
            const converted = fieldsToConvert[key];
            if (converted) {
                conf[converted] = conf[key];
                delete conf[key];
            } else if (Object.prototype.toString.call(conf[key]) === '[object Object]') {
                convert(conf[key]);
            }
        }
    }
}

module.exports = api;
