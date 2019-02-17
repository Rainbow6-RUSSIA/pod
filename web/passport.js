const passport = require('passport');
const DiscordStrategy = require('passport-discord').Strategy;
const pod = require('../lib/api');
const conf = pod.reloadConfig();

passport.use('discord', new DiscordStrategy({
    authorizationURL: 'https://discordapp.com/api/oauth2/authorize',
    callbackURL: conf.web.callbackURL,
    clientID: conf.web.clientID,
    clientSecret: conf.web.clientSecret,
    tokenURL: 'https://discordapp.com/api/oauth2/token',
    scope: ['identify']
}, (accessToken, refreshToken, profile, done) => {
    if (conf.web.discordIDs.includes(profile.id)) {
        return done(null, profile);
    } else {
        return done({err: 'fok u'});
    }
}))