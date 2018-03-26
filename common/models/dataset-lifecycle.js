'use strict';
var config = require('../../server/config.local');
var utils = require('./utils');


module.exports = function(Datasetlifecycle) {

    // put
    Datasetlifecycle.beforeRemote('replaceOrCreate', function(ctx, instance, next) {
        utils.updateTimesToUTC(['dateOfLastMessage'], ctx.args.data);
        next();
    });

    //patch
    Datasetlifecycle.beforeRemote('patchOrCreate', function(ctx, instance, next) {
        utils.updateTimesToUTC(['dateOfLastMessage'], ctx.args.data);
        next();
    });


    //post
    Datasetlifecycle.beforeRemote('create', function(ctx, unused, next) {
        utils.updateTimesToUTC(['dateOfLastMessage'], ctx.args.data);
        next();
    });


    Datasetlifecycle.observe('before save', (ctx, next) => {
        // auto fill retention and publishing time only at initial creation time
        // in this case only ctx.instance is defined
        if (ctx.instance) {
            // auto fill retention and publishing time
            var now = new Date();
            if (!ctx.instance.dateOfLastMessage) {
                ctx.instance.dateOfLastMessage = now.toISOString();
            }
            if (!ctx.instance.archiveRetentionTime) {
                var retention = new Date(now.setFullYear(now.getFullYear() + config.policyRetentionShiftInYears));
                ctx.instance.archiveRetentionTime = retention.toISOString().substring(0, 10);
            }
            if (!ctx.instance.dateOfPublishing) {
                now = new Date(); // now was modified above
                var pubDate = new Date(now.setFullYear(now.getFullYear() + config.policyPublicationShiftInYears));
                ctx.instance.dateOfPublishing = pubDate.toISOString().substring(0, 10);
            }
        }
        // add ownerGroup field from linked Datasets
        utils.addOwnerGroup(ctx, next)
     })

     Datasetlifecycle.isValid = function(instance, next) {
         var ds = new Datasetlifecycle(instance)
         ds.isValid(function(valid) {
             if (!valid) {
                 next(null, {
                     'errors': ds.errors,
                     'valid': false
                 })
             } else {
                 next(null, {
                     'valid': true
                 })
             }
         });
     }

};
