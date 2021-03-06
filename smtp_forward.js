/**
 * 
 * The Bipio Email Pod.  smtp_forward action definition
 * 
 * @author Michael Pearson <michael@cloudspark.com.au>
 * Copyright (c) 2010-2013 CloudSpark pty ltd http://www.cloudspark.com.au
 * 
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *  
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *  
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <http://www.gnu.org/licenses/>.
 */
var crypto = require('crypto'),
    uuid = require('node-uuid'),
    fs = require('fs'),
    nodemailer = require('nodemailer'),
    ejs = require('ejs'),
    smtpTransport;

// sets up the smtp_forward container for first time use
//
// Checks if the email address needs to be verified, if so, then marks as
// verified and we can just use it.
//
// If the channel is marked as 'pending', then we don't do anything and the
// channel remains unverified (unable to use).
//
// Ideally a 'pending' flag should generate a 202 Accepted header
//
// If the channel is marked as 'no_global', then we generate validation error
// or a user alert via the dao and drop the channel.
//

function sendVerifyEmail(dao, nonce, recipient, accountInfo, next) {    
    var userDom = accountInfo.getDefaultDomainStr(),
        callbackUrl = userDom + '/rpc/pod/email/smtp_forward/verify?_nonce=' + nonce + '&accept=';
        self = this,
        mailTemplate = fs.readFileSync(__dirname + '/templates/email_confirm.ejs', 'utf8'),
        templateVars = {
            'name' : accountInfo.user.name !== '' ? accountInfo.user.name : accountInfo.user.username,
            'name_first' : accountInfo.user.given_name !== '' ? accountInfo.user.given_name : accountInfo.user.username,
            'opt_in' : callbackUrl + 'accept',  // channel accept callback
            'opt_out_perm' : callbackUrl + 'no_global' // global optout
        },
        mailOptions = {
            from: "bipio app <support@bip.io>",
            to: recipient,
            subject: templateVars['name'] + " wants to connect!"
        };

    if (!templateVars['name_first']) {
        templateVars['name_first'] = templateVars['name'];
    }

    mailOptions.html = ejs.render(mailTemplate, templateVars);

    // send email
    smtpTransport.sendMail(mailOptions, next);    
}

function createVerifyObject($resource, modelName, channel, accountInfo, next) {
    var hash = crypto.createHash('md5');

    // nonce is random
    verifyObj = {
        'email_verify' : channel.config.rcpt_to,
        'owner_id' : channel.owner_id,
        'nonce' : hash.update(uuid.v4() + channel.id).digest('base64'),
        'mode' : 'pending'
    };

    model = $resource.dao.modelFactory(modelName, verifyObj, accountInfo);

    $resource.dao.create(model, function(err, result) {
        // ask the user to verify they'll accept messages
        if (!err && result) {
            sendVerifyEmail(
                $resource.dao, 
                model.nonce, 
                channel.config.rcpt_to, 
                accountInfo, 
                function(error, response) {                
                    if(!error) {
                        $resource.log("Message sent: " + response.message, channel);
                    } else {
                        // @todo - raise with orignating user to fix email address
                        // if broken and manually resend
                        $resource.log(error + response, channel, 'error');
                    }
                }
            );
        }
        next(err, 'channel', channel, 202);
    }, accountInfo);
}

/*
 * --------------------------------------------------------------- smtp_forward
 *
 * Actions relays email outbound
 *
 */
function SmtpForward(podConfig) {    
    // pod name. alphanumeric + underscore only
    this.name = 'smtp_forward'; 
    
    // quick description
    this.description = 'Send an Email'; 
    
    // long description
    this.description_long = 'Use to forward email messages to a chosen recipient (requires recipient verification)';

    // behaviors
    this.trigger = false; // can be a periodic trigger
    this.singleton = false; // only 1 instance per account
    this.auth_required = false; // this action will handle rpc auth.
    
    smtpTransport = nodemailer.createTransport("smtp", podConfig.mailer);    
}

SmtpForward.prototype = {};

SmtpForward.prototype.getSchema = function() {
    return {
        config : {
            properties : {
                rcpt_to: {
                    type: "string",
                    description: 'Email Address (eg: foo@bar.com)',
                    optional: false,
                    unique : true,
                    validate: [
                        {
                            pattern : 'email',
                            msg : 'Invalid Email'
                        }/*
                        {
                            msg : 'Recipient has opted out of communication'
                        }*/
                    ]
                }
            }
        },
    
        exports : {
            properties : {
                'response_code' : {
                    type : Number,
                    description: 'SMTP Response Code'
                },
                'response_message' : {
                    type : String,
                    description: 'SMTP Response Message'
                }
            }
        },
    
        imports : {
            properties : {
                "subject" : {
                    "type" : String,
                    "description" : "Message Subject"
                },
                "body_html" : {
                    "type" : String,
                    "description" : "HTML Message Body"
                },
                "body_text" : {
                    "type" : String,
                    "description" : "Text Message Body"
                },
                "reply_to" : {
                    "type" : String,
                    "description" : "Reply To"
                }
            }
        }
    };
}

/**
 * Returns a string representation for channels configured for this action
 * 
 * @param channelConfig {Object} Channel Config Struct.
 **/
SmtpForward.prototype.repr = function(channelConfig) {
    return this.description + (channelConfig ? ' to ' + channelConfig.rcpt_to : '');
}

/**
 * Sets up the provided channel for use.
 *
 */
SmtpForward.prototype.setup = function(channel, accountInfo, next) {
    var $resource = this.$resource,
        dao = $resource.dao, 
        modelName = this.$resource.getDataSourceName('verify');

    dao.findFilter(
        modelName,
        {
            'email_verify' : channel.config.rcpt_to
        },
        function(err, results) {
            var verified = false, pending = false, verifyObj, hash, model;

            if (err) {
                next(err, 'channel', channel, 500);
            } else {
                if (!results) {              
                    createVerifyObject(
                        $resource,
                        modelName,
                        channel,
                        accountInfo,
                        next
                    );
                } else {

                    // iterate over results.
                    // 
                    var finalMode, result;
                    
                    for (var idx in results) {
                        result = results[idx];
                        // if there's a global deny, then bounce it
                        if (result.mode == 'no_global') {
                            finalMode = 'no_global';
                        }
                        
                        // if we find a pending request from this user,
                        // then it should still be pending
                        if (result.owner_id == channel.owner_id) {
                            if (result.mode == 'accept' || (!finalMode && result.mode == 'pending')) {
                                finalMode = result.mode;
                                // we break on 'accept', but give the opportunity
                                // to find a 'no_global' catch.  Or in other words,
                                // no_global invalidates any pending requests
                                if (finalMode == 'accept') {
                                    break;
                                }
                            }                            
                        }
                    }

                    // create a verification message for this user -> recipient
                    if (!finalMode) {
                        createVerifyObject($resource, modelName, channel, accountInfo, next);

                    } else if (finalMode == 'no_global') {
                        // forbidden channels are deleted
                        dao.remove(channel, channel.id, accountInfo);
                        var errorPacket = {
                            'config.rcpt_to' : {
                                'message' : 'Recipient Unavailable'
                            }
                        };
                        next(err, {
                            'status' : 403, 
                            'message' : 'ValidationError', 
                            'errors' : errorPacket
                        }, 403); // forbidden

                    } else if (finalMode == 'accept') {
                        next(err, 'channel', channel, 200); // ok
                        
                    } else if (finalMode == 'pending') {
                        channel._available = false;
                        dao.updateColumn('channel', channel.id, { '_available' : false }, function(err, result) {
                            if (err) {
                                console.log(err);
                            }
                            next(err, 'channel', channel, (err) ? 500 : 202); // deferred
                        });
                        
                    }
                }
            }
        }
        );
};

/**
 *
 */
SmtpForward.prototype.rpc = function(method, sysImports, options, channel, req, res) {
    var dao = this.$resource.dao, modelName, log = $resource.log;

    // Remote client is performing a verify action.
    if (method == 'verify') {
        modelName = this.$resource.getDataSourceName('verify');
        var acceptMode, nonce, ownerId;

        acceptMode = options.accept;
        nonce = options._nonce;
        ownerId = req.remoteUser.user.id;

        // find the verification record
        dao.find(
            modelName,
            {
                'nonce' : nonce
            },
            function(err, result) {
                if (err) {
                    res.send(500);
                    log(error, 'error');
                } else if (!result) {
                    res.send(404);
                } else {
                    // update verify object
                    dao.updateColumn(modelName, result.id, {
                        'mode' : acceptMode
                    } );

                    // update all channels for the requesting user, with this recipient response
                    dao.findFilter('channel', {
                        'owner_id' : ownerId, 
                        'config' : {
                            'rcpt_to' : result.email_verify
                        }
                    }, function(err, results) {
                        if (err || !result) {
                            res.send(404);
                        } else {                           
                            for (i in results) {
                                // drop this channel from the account if the recipient
                                // has opted out.
                                if (acceptMode === 'no_global') {
                                    dao.removeFilter('channel', { id : results[i].id });
                                } else {
                                    dao.updateColumn('channel', results[i].id, {
                                        _available : acceptMode == 'accept' ? true : false
                                    });
                                }
                            }
                            
                            if (acceptMode === 'accept') {                                
                                dao.webFinger(result.email_verify, function(err, xrd) {
                                    // @todo fire off a webfinger job for this channel to attach icon
                                    // http://www.google.com/s2/webfinger/?q={rcpt_to}
                                });
                            }
                        }
                    });
                    
                    res.redirect(301, CFG.website_public + '/emitter/email_verify/' + acceptMode);
                }
            }
        );    
    } else {
        res.send(404);
    }
}


/**
 * Invokes (runs) the action.
 * 
 */
SmtpForward.prototype.invoke = function(imports, channel, sysImports, contentParts, next) {
    var log = this.$resource.log;
    // if imports 'body' is an object or array, then flatten
    var body = "";
    if  (imports.body instanceof Object) {
        for (key in imports.body) {
            body += key + ':' + imports.body[key] + "\n";
        }
    } else {
        body = imports.body;
    }

    if (sysImports.reply_to == '') {
        sysImports.reply_to = 'noreply@bip.io';
    }

    var mailOptions = {
        'from' : sysImports.reply_to,
        'to' : channel.config.rcpt_to,
        'subject' : imports.subject,
        'text' : imports.body_text,
        'html' : imports.body_html,
        attachments : []
    }

    if (contentParts._files && contentParts._files.length > 0) {        
        for (var i = 0; i < contentParts._files.length; i++) {
            mailOptions.attachments.push({
                fileName : contentParts._files[i].name,
                streamSource: fs.createReadStream(contentParts._files[i].localpath)
            });
        }
    }

    // extract parts
    if (undefined != imports.parts && imports.parts.length > 0) {
        var partLen = imports.parts.length, p = imports.parts, b;
        for (var i = 0; i < partLen; i++) {
            b = p[i].body;
            if (p[i].content_type == 'text/plain') {
                mailOptions.text = b;
            } else if (p[i].content_type == 'text/html') {
                mailOptions.html = b;
            }
        }
    }

    smtpTransport.sendMail(mailOptions, function(error, response){
        var exports = {
            'response_message' : ''
            };
        if (error) {
            log(error, channel, 'error');
        }
console.log(error);            
        exports.response_message = (error) ? error.message : response.message;       
        next(error, exports);
        
        return;
    });
}

// -----------------------------------------------------------------------------
module.exports = SmtpForward;
