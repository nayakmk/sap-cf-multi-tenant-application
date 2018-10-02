'use strict';

const _ = require('lodash');
const path = require('path');
const Promise = require('bluebird');
const hanaClient = Promise.promisifyAll(require('@sap/hdbext'));
const xsenv = require('@sap/xsenv');
const hdiDeployer = require('@sap/hdi-deploy/library');
const logger = require('../logger');
const XsuaaTrustManager = require('../dbConnector/XsUaaTrustManager');

const ONBOARDED = 'ONBOARDED';
const ONBOARDING = 'ONBOARDING_IN_PROCESS';
const OFFBOARDING = 'OFFBOARDING_IN_PROCESS';
const OFFBOARDED = 'OFFBOARDED';

const boundServices = xsenv.readCFServices();
const hanaConfig = boundServices[process.env.HANA_DBAAS_INSTANCE].credentials;

function getVcapServices(credentials) {
    return {
        "VCAP_SERVICES": JSON.stringify({
            "hana": [{
                "credentials": credentials,
                "tags": ['hana']
            }]
        })
    };
}

class TenantLifecycleManager {
    constructor(cloudController) {
        this.cloudController = cloudController;
        this.tenants = {};
        this.cacheLoaded = false;
    }

    addTenantConfigInCache(tenantId, opts) {
        this.tenants[tenantId] = _.assign({
            instanceId: undefined,
            state: ONBOARDED,
            keyId: undefined,
            credentials: undefined
        }, opts);
    }

    updateTenantConfigInCache(tenantId, opts) {
        let cached = _.get(this.tenants, tenantId, {});
        this.tenants[tenantId] = _.assign(cached, opts);
    }

    getCredentialsForTenant(tenantId) {
        if (_.has(this.tenants, tenantId)) {
            return this.tenants[tenantId].credentials;
        }
        throw new Error(`Credentials not found for tenant ${tenantId}`);
    }

    cacheForAllTenants() {
        logger.info('caching all tenants...');
        return this.getAllSubscribedTenants()
            .then(tenantDbRows => {
                logger.info(`Found ${tenantDbRows.length} tenants`);
                return Promise.map(tenantDbRows, tenantInfo => {
                        let tenantId = tenantInfo.TENANT_ID;
                        let keyId = tenantInfo.KEY_ID;
                        let instanceId = tenantInfo.INSTANCE_ID;
                        return this.cloudController.getTenantCredentials(tenantInfo.TENANT_ID, tenantInfo.KEY_ID)
                            .then(creds => this.addTenantConfigInCache(tenantId, {
                                instanceId: instanceId,
                                state: ONBOARDED,
                                keyId: keyId,
                                credentials: creds
                            }))
                            .catch(err => {
                                logger.error(`tenant credentials could not be loaded for ${tenantId}`, err);
                            });
                    })
                    .then(() => {
                        logger.info('All subscriptions loaded in memory');
                        this.cacheLoaded = true;
                    });
            });
    }

    getAllSubscribedTenants() {
        logger.info('fetching all subscriptions');
        let hanaConnection, tenants = [];
        return hanaClient.createConnectionAsync(hanaConfig)
            .tap(conn => hanaConnection = conn)
            .then(conn => conn.execAsync('select * from "business::TENANT_MASTER"'))
            .tap(rows => tenants = rows)
            .catch(err => {
                logger.error('Fetching all subscribed tenants failed', err);
                throw err;
            })
            .finally(() => {
                logger.info('closing HANA connection');
                hanaConnection.close();
            });
    }

    getTenantConfig(tenantId) {
        let hanaConnection;
        return hanaClient.createConnectionAsync(hanaConfig)
            .tap(conn => hanaConnection = conn)
            .then(conn => conn.prepareAsync('select * from "business::TENANT_MASTER" where TENANT_ID=?'))
            .then(stmt => {
                return new Promise((resolve, reject) => {
                    stmt.exec([tenantId], (err, rows) => {
                        if (err) {
                            return reject(err);
                        }
                        if (!_.isArray(rows) || rows.length !== 1) {
                            return reject(new Error(`Fetching tenant ${tenantId} failed: something went awry`));
                        }
                        return resolve(rows[0]);
                    });
                });
            })
            .finally(() => {
                logger.info('closing HANA connection');
                hanaConnection.close();
            });
    }

    deleteTenantConfig(tenantId) {
        let hanaConnection;
        return hanaClient.createConnectionAsync(hanaConfig)
            .tap(conn => hanaConnection = conn)
            .then(conn => conn.prepareAsync('delete from "business::TENANT_MASTER" where TENANT_ID=?'))
            .then(stmt => {
                return new Promise((resolve, reject) => {
                    stmt.exec([tenantId], (err, res) => {
                        if (err) {
                            return reject(err);
                        }
                        return resolve(res);
                    });
                });
            })
            .catch(err => {
                logger.error(`Error removing tenant ${tenantId} from master collection`, err);
                throw err;
            })
            .finally(() => {
                logger.info('closing HANA connection');
                hanaConnection.close();
            });
    }

    addTenantConfig(tenantId, instanceId, keyId) {
        logger.info(`adding tenant config into master for ${tenantId}, ${instanceId}, ${keyId}`);
        let hanaConnection;
        return hanaClient.createConnectionAsync(hanaConfig)
            .tap(conn => hanaConnection = conn)
            .then(conn => conn.prepareAsync('insert into "business::TENANT_MASTER" (tenant_id, instance_id, key_id) values(?,?,?)'))
            .then(stmt => {
                return new Promise((resolve, reject) => {
                    stmt.exec([tenantId, instanceId, keyId], (err, res) => {
                        if (err) {
                            return reject(err);
                        }
                        return resolve(res);
                    });
                });
            })
            .catch(err => {
                logger.error(`Error adding tenant ${tenantId} to master collection`, err);
                throw err;
            })
            .finally(() => {
                logger.info('closing HANA connection');
                hanaConnection.close();
            });
    }

    deployTenantContent(credentials) {
        logger.info(`deploying content into tenant database`);
        logger.info(`credentials used: ${credentials}`);
        let deployPromise = new Promise((resolve, reject) => {
            hdiDeployer.deploy(path.join(__dirname, '..', 'tenant-db'), getVcapServices(credentials), (err, result) => {
                if (err) {
                    return reject(err);
                }
                if (result.exitCode === 1) {
                    return reject(new Error(JSON.stringify(result.messages)));
                }
                return resolve(result.messages);
            });
        });
        return deployPromise;
    }

    setupTrustForTenant(tenantDomain, tenantId) {
        const trustManager = new XsuaaTrustManager(tenantDomain, tenantId);
        return trustManager.establishTenantTrust();
    }

    dropTrustForTenant(tenantDomain, tenantId) {
        const trustManager = new XsuaaTrustManager(tenantDomain, tenantId);
        return trustManager.destroyTenantTrust();
    }

    onboardTenant(tenantId, tenantDomain) {
        logger.info(`onboarding for tenant ${tenantId} started`);
        let instanceId, keyId;
        Promise.try(() => {
                this.addTenantConfigInCache(tenantId, {
                    state: ONBOARDING
                });
            })
            .then(() => this.cloudController.createServiceInstanceForTenant(tenantId))
            .tap(id => instanceId = id)
            .then(instanceId => this.cloudController.createServiceKey(instanceId, 'tenantKey'))
            .then(res => {
                keyId = res.body.metadata.guid;
                const tenantCredentials = res.body.entity.credentials;
                this.updateTenantConfigInCache(tenantId, {
                    credentials: tenantCredentials
                });
                return tenantCredentials;
            })
            .then(credentials => this.deployTenantContent(credentials))
            .then(() => {
                this.updateTenantConfigInCache(tenantId, {
                    state: ONBOARDED,
                    instanceId: instanceId,
                    keyId: keyId
                });
                return this.addTenantConfig(tenantId, instanceId, keyId, ONBOARDING);
            })
            .then(() => this.setupTrustForTenant(tenantDomain, tenantId))
            .then(() => {
                logger.info(`Onboarding completed for tenant ${tenantId}`);
                logger.info(`Tenant information: ${JSON.stringify(this.tenants[tenantId])}`)
            });
    }

    offboardTenant(tenantId, tenantDomain) {
        let instanceId, keyId;
        this.getTenantConfig(tenantId)
            .then(tenant => {
                instanceId = tenant.INSTANCE_ID;
                keyId = tenant.KEY_ID;
            })
            .then(() => this.updateTenantConfigInCache(tenantId, {
                state: OFFBOARDING
            }))
            .then(() => this.cloudController.deleteServiceKey(keyId))
            .then(() => this.cloudController.deleteServiceInstance(instanceId))
            .then(() => this.deleteTenantConfig(tenantId))
            .then(() => this.updateTenantConfigInCache(tenantId, {
                state: OFFBOARDED,
                instanceId: null,
                tenantId: null
            }))
            .then(() => this.dropTrustForTenant(tenantDomain, tenantId));
    }
}

module.exports = TenantLifecycleManager;