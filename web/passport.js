const passport = require('passport');
const DiscordStrategy = require('passport-discord').Strategy;

passport.use('discord', new DiscordStratey({
    authorizationURL: 'https://discordapp.com/api/oauth2/authorize',
    callbackURL: process.env.CALLBACK_URL,
    clientID: process.env.CLIENT_ID,
    clientSecret: process.env.CLIENT_SECRET,
    tokenURL: 'https://discordapp.com/api/oauth2/token',
    scope: ['identify']
}, (accessToken, refreshToken, profile, done) => {
    if (process.env.OWNERS.split(',').includes(profile.id)) {
        return done(null, profile);
    } else {
        return done({err: 'fok u'});
    }
}))