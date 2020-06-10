import { ChargePointErrorCode, ChargePointStatus, OCPP15TransactionData, OCPPLocation, OCPPMeasurand, OCPPMeterValue, OCPPReadingContext, OCPPStatusNotificationRequest, OCPPUnitOfMeasure, OCPPValueFormat, OCPPVersion } from '../../src/types/ocpp/OCPPServer';
import Transaction, { InactivityStatus } from '../../src/types/Transaction';
import chai, { expect } from 'chai';

import CentralServerService from './client/CentralServerService';
import ChargingStationContext from './context/ChargingStationContext';
import Factory from '../factories/Factory';
import { PricingSettingsType } from '../../src/types/Setting';
import TenantContext from './context/TenantContext';
import User from '../../src/types/User';
import Utils from '../../src/utils/Utils';
import chaiSubset from 'chai-subset';
import { fail } from 'assert';
import faker from 'faker';
import moment from 'moment';
import responseHelper from '../helpers/responseHelper';

chai.use(chaiSubset);
chai.use(responseHelper);

export default class OCPPCommonTests {

  public tenantContext: TenantContext;
  public chargingStationContext: ChargingStationContext;
  public centralUserContext: any;
  public centralUserService: CentralServerService;

  public currentPricingSetting;
  public priceKWH = 2;
  public chargingStationConnector1: OCPPStatusNotificationRequest;
  public chargingStationConnector2: OCPPStatusNotificationRequest;
  public transactionStartUser: User;
  public transactionStartUserService: CentralServerService;
  public transactionStopUser: User;
  public transactionStartMeterValue: number;
  public transactionStartSoC: number;
  public energyActiveImportMeterValues: number[];
  public powerImportMeterValues: number[];
  public totalInactivities: number[];
  public socMeterValues: number[];
  public transactionSignedData: string;
  public transactionEndSignedData: string;
  public meterValueIntervalSecs: number;
  public transactionStartTime: Date;
  public transactionTotalConsumptionWh: number;
  public energyActiveImportFinalMeterValue: number;
  public socFinalMeterValue: number;
  public transactionTotalInactivitySecs: number;
  public totalPrice: number;
  public newTransaction: Transaction;
  public transactionCurrentTime: Date;

  public createAnyUser = false;
  public numberTag: number;
  public validTag: string;
  public invalidTag: string;
  public anyUser: User;
  public createdUsers: User[] = [];

  public constructor(tenantContext: TenantContext, centralUserContext, createAnyUser = false) {
    expect(tenantContext).to.exist;
    this.tenantContext = tenantContext;
    this.centralUserContext = centralUserContext;
    expect(centralUserContext).to.exist;
    // Avoid double login for identical user contexts
    const centralAdminUserService = this.tenantContext.getAdminCentralServerService();
    if (this.centralUserContext.email === centralAdminUserService.getAuthenticatedUserEmail()) {
      this.centralUserService = centralAdminUserService;
    } else {
      this.centralUserService = new CentralServerService(this.tenantContext.getTenant().subdomain, this.centralUserContext);
    }
    this.createAnyUser = createAnyUser;
  }

  public setChargingStation(chargingStationContext) {
    expect(chargingStationContext).to.exist;
    this.chargingStationContext = chargingStationContext;
  }

  public setUsers(startUserContext, stopUserContext?) {
    expect(startUserContext).to.exist;
    this.transactionStartUser = startUserContext;
    if (stopUserContext) {
      this.transactionStopUser = stopUserContext;
    } else {
      this.transactionStopUser = this.transactionStartUser;
    }
    // Avoid double login for identical user contexts
    if (this.transactionStartUser === this.centralUserContext) {
      this.transactionStartUserService = this.centralUserService;
    } else {
      this.transactionStartUserService = new CentralServerService(
        this.tenantContext.getTenant().subdomain, this.transactionStartUser);
    }
  }

  public async assignAnyUserToSite(siteContext) {
    expect(siteContext).to.exist;
    if (this.anyUser) {
      await this.centralUserService.siteApi.addUsersToSite(siteContext.getSite().id, [this.anyUser.id]);
    }
  }

  public async before() {
    const allSettings = await this.centralUserService.settingApi.readAll({});
    this.currentPricingSetting = allSettings.data.result.find((s) => s.identifier === 'pricing');
    if (this.currentPricingSetting) {
      await this.centralUserService.updatePriceSetting(this.priceKWH, 'EUR');
    }
    // Default Connector values
    this.chargingStationConnector1 = {
      connectorId: 1,
      status: ChargePointStatus.AVAILABLE,
      errorCode: ChargePointErrorCode.NO_ERROR,
      timestamp: new Date().toISOString()
    };
    this.chargingStationConnector2 = {
      connectorId: 2,
      status: ChargePointStatus.AVAILABLE,
      errorCode: ChargePointErrorCode.NO_ERROR,
      timestamp: new Date().toISOString()
    };
    // Set meter value start
    this.transactionStartMeterValue = 0;
    this.meterValueIntervalSecs = 60;
    // eslint-disable-next-line no-useless-escape
    this.transactionSignedData = '<?xml version=\"1.0\" encoding=\"UTF-8\" ?><signedMeterValue>  <publicKey encoding=\"base64\">8Y5UzWD+TZeMKBDkKLpHhwzSfGsnCvo00ndCXv/LVRD5pAVtRZEA49bqpr/DY3KL</publicKey>  <meterValueSignature encoding=\"base64\">wQdZJR1CLRe+QhS3C+kHpkfVL4hqPhc8YIt/+4uHBBb9N6JNygltdEhYufTfaM++AJ8=</meterValueSignature>  <signatureMethod>ECDSA192SHA256</signatureMethod>  <encodingMethod>EDL</encodingMethod>  <encodedMeterValue encoding=\"base64\">CQFFTUgAAH+eoQxVP10I4Zf9ACcAAAABAAERAP8e/5KqWwEAAAAAAJ9sYQoCAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAtVP10AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=</encodedMeterValue></signedMeterValue>';
    // eslint-disable-next-line no-useless-escape
    this.transactionEndSignedData = '<?xml version=\"1.0\" encoding=\"UTF-8\" ?><signedMeterValue>  <publicKey encoding=\"base64\">8Y5UzWD+TZeMKBDkKLpHhwzSfGsnCvo00ndCXv/LVRD5pAVtRZEA49bqpr/DY3KL</publicKey>  <meterValueSignature encoding=\"base64\">GChPf/f+0Rw6DDWI0mujec6dOMDqm5cuCLXdEVV6MRua6OVqcHNP85q7K70tRPJKAJ8=</meterValueSignature>  <signatureMethod>ECDSA192SHA256</signatureMethod>  <encodingMethod>EDL</encodingMethod>  <encodedMeterValue encoding=\"base64\">CQFFTUgAAH+eodYDQF0IrEb+ACgAAAABAAERAP8e/8OtYQEAAAAAAJ9sYQoCAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAtVP10AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=</encodedMeterValue></signedMeterValue>';
    // Energy Import Meter Value (14 values)
    this.energyActiveImportMeterValues = Array.from({ length: 12 }, () => faker.random.number({
      min: 200,
      max: 500
    })).concat([0, 0]);
    // SoC Meter Value (14 values)
    this.socMeterValues = Array.from({ length: 8 }, () => faker.random.number({
      min: 10,
      max: 90
    })).concat([8, 8, 98, 99, 100, 100]).sort((a, b) => (a - b));
    this.transactionStartSoC = this.socMeterValues[0];
    // Power Import (14 values)
    this.powerImportMeterValues = [];
    for (let i = 0; i < this.energyActiveImportMeterValues.length; i++) {
      this.powerImportMeterValues.push(
        this.energyActiveImportMeterValues[i] * (3600 / this.meterValueIntervalSecs));
    }
    // Total Inactivity (14 values)
    this.totalInactivities = [];
    let lastInactivity = 0;
    for (let i = 0; i < this.energyActiveImportMeterValues.length; i++) {
      lastInactivity += (this.energyActiveImportMeterValues[i] === 0 ? this.meterValueIntervalSecs : 0);
      this.totalInactivities.push(lastInactivity);
    }
    // Meter Values params
    this.transactionStartTime = moment().subtract(this.energyActiveImportMeterValues.length * this.meterValueIntervalSecs + 1, 'seconds').toDate();
    this.transactionTotalConsumptionWh = this.energyActiveImportMeterValues.reduce((sum, meterValue) => sum + meterValue);
    this.energyActiveImportFinalMeterValue = this.transactionStartMeterValue + this.transactionTotalConsumptionWh;
    this.socFinalMeterValue = this.socMeterValues[this.socMeterValues.length - 1];
    this.transactionTotalInactivitySecs = this.energyActiveImportMeterValues.reduce(
      (sum, meterValue) => (meterValue === 0 ? sum + this.meterValueIntervalSecs : sum), 0);
    this.totalPrice = this.priceKWH * (this.transactionTotalConsumptionWh / 1000);
    // Tags
    this.validTag = faker.random.alphaNumeric(20).toString();
    this.invalidTag = faker.random.alphaNumeric(21).toString();
    this.numberTag = faker.random.number(10000);
    if (this.createAnyUser) {
      this.anyUser = await this.createUser(Factory.user.build({
        tags: [
          { id: this.validTag, issuer: true, active: true },
          { id: this.invalidTag, issuer: true, active: true },
          { id: this.numberTag.toString(), issuer: true, active: true }
        ]
      }));
      if (!this.createdUsers) {
        this.createdUsers = [];
      }
      this.createdUsers.push(this.anyUser);
    }
  }

  public async after() {
    if (this.currentPricingSetting) {
      await this.centralUserService.settingApi.update(this.currentPricingSetting);
    }
    if (this.createdUsers && Array.isArray(this.createdUsers)) {
      // eslint-disable-next-line @typescript-eslint/no-misused-promises
      this.createdUsers.forEach(async (user) => {
        await this.centralUserService.deleteEntity(
          this.centralUserService.userApi, user);
      });
    }
  }

  public async testConnectorStatus() {
    let response = await this.chargingStationContext.setConnectorStatus(this.chargingStationConnector1);
    expect(response).to.eql({});
    response = await this.chargingStationContext.setConnectorStatus(this.chargingStationConnector2);
    expect(response).to.eql({});
    // Attention: connector status is always 'Unavailable', if too much time has passed since last heartbeat!!
    response = await this.chargingStationContext.sendHeartbeat();
    // Now we can test the connector status!
    const foundChargingStation = await this.chargingStationContext.readChargingStation();
    expect(foundChargingStation.status).to.equal(200);
    expect(foundChargingStation.data.id).is.eql(this.chargingStationContext.getChargingStation().id);
    // Check
    expect(foundChargingStation.data.connectors).to.not.be.null;
    expect(foundChargingStation.data.connectors[0]).to.include({
      status: this.chargingStationConnector1.status,
      errorCode: this.chargingStationConnector1.errorCode
    });
    expect(foundChargingStation.data.connectors[1]).to.include({
      status: this.chargingStationConnector2.status,
      errorCode: this.chargingStationConnector2.errorCode
    });
  }

  public async testChangeConnectorStatus() {
    // Set it to Occupied
    this.chargingStationConnector1.status = ChargePointStatus.OCCUPIED;
    this.chargingStationConnector1.timestamp = new Date().toISOString();
    // Update
    let response = await this.chargingStationContext.setConnectorStatus(this.chargingStationConnector1);
    // Check
    expect(response).to.eql({});
    // To be sure send a heartbeat
    response = await this.chargingStationContext.sendHeartbeat();
    // Check the connectors
    const foundChargingStation = await this.chargingStationContext.readChargingStation();
    expect(foundChargingStation.status).to.equal(200);
    expect(foundChargingStation.data.id).is.eql(this.chargingStationContext.getChargingStation().id);
    // Check Connector 1
    expect(foundChargingStation.data.connectors[0]).to.include({
      status: this.chargingStationConnector1.status,
      errorCode: this.chargingStationConnector1.errorCode
    });
    // Connector 2 should be still 'Available'
    expect(foundChargingStation.data.connectors[1]).to.include({
      status: this.chargingStationConnector2.status,
      errorCode: this.chargingStationConnector2.errorCode
    });
    // Reset Status of Connector 1
    this.chargingStationConnector1.status = ChargePointStatus.AVAILABLE;
    this.chargingStationConnector1.timestamp = new Date().toISOString();
    // Update
    response = await this.chargingStationContext.setConnectorStatus(this.chargingStationConnector1);
    // Check
    expect(response).to.eql({});
  }

  public async testHeartbeat() {
    // Update Status of Connector 1
    const response = await this.chargingStationContext.sendHeartbeat();
    // Check
    expect(response).to.have.property('currentTime');
  }

  public async testClientIP() {
    // Read charging station
    const response = await this.chargingStationContext.readChargingStation();
    // Check the presence of the IP
    expect(response.data).to.have.property('currentIPAddress');
    expect(response.data.currentIPAddress).to.not.be.empty;
  }

  public async testServerLocalIP() {
    // Read charging station
    const response = await this.chargingStationContext.readChargingStation();
    // Check the presence of the server local IP
    expect(response.data).to.have.property('currentServerLocalIPAddressPort');
    expect(response.data.currentServerLocalIPAddressPort).to.not.be.empty;
  }

  public async testDataTransfer() {
    // Check
    const response = await this.chargingStationContext.transferData({
      'vendorId': 'Schneider Electric',
      'messageId': 'Detection loop',
      'data': '{\\"connectorId\\":2,\\"name\\":\\"Vehicle\\",\\"state\\":\\"0\\",\\"timestamp\\":\\"2018-08-08T10:21:11Z:\\"}',
      'chargeBoxID': this.chargingStationContext.getChargingStation().id,
      'timestamp': new Date().toDateString()
    });
    // Check
    expect(response).to.have.property('status');
    expect(response.status).to.equal('Accepted');
  }

  public async testChargingStationRegistrationWithInvalidToken() {
    const response = await this.chargingStationContext.sendBootNotification();
    expect(response).not.to.be.null;
    expect(response.status).eq('Rejected');
  }

  public async testChargingStationRegistrationWithInvalidIdentifier() {
    try {
      await this.chargingStationContext.sendBootNotification();
      fail('BootNotification should failed');
    } catch (error) {
      expect(error).to.be.not.null;
    }
  }

  public async testAuthorizeUsers() {
    // Asserts that the start user is authorized.
    await this.testAuthorize(this.transactionStartUser.tags[0].id, 'Accepted');
    // Asserts that the stop user is authorized.
    await this.testAuthorize(this.transactionStopUser.tags[0].id, 'Accepted');
    // Asserts that the user with a too long tag is not authorized.
    await this.testAuthorize('ThisIsATooTooTooLongTag', 'Invalid');
  }

  public async testStartTransaction(validTransaction = true) {
    // Start a new Transaction
    const startTransactionResponse = await this.chargingStationContext.startTransaction(
      this.chargingStationConnector1.connectorId,
      this.transactionStartUser.tags[0].id,
      this.transactionStartMeterValue,
      this.transactionStartTime
    );
    if (validTransaction) {
    // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(startTransactionResponse).to.be.transactionValid;
      const transactionId = startTransactionResponse.transactionId;
      await this.validateStartedTransaction(
        startTransactionResponse,
        this.chargingStationConnector1,
        this.transactionStartMeterValue,
        this.transactionStartTime);
      this.newTransaction = (await this.centralUserService.transactionApi.readById(transactionId)).data;
      expect(this.newTransaction).to.not.be.null;

      const chargingStationResponse = await this.chargingStationContext.readChargingStation(this.transactionStartUserService);
      expect(chargingStationResponse.status).eq(200);
      expect(chargingStationResponse.data).not.null;
      const connector = chargingStationResponse.data.connectors[this.chargingStationConnector1.connectorId - 1];
      expect(connector).not.null;
      expect(connector.currentTransactionID).eq(transactionId);
      expect(connector.currentTransactionDate).eq(this.transactionStartTime.toISOString());
      expect(connector.currentTagID).eq(this.transactionStartUser.tags[0].id);
    } else {
      this.newTransaction = null;
      expect(startTransactionResponse).to.be.transactionStatus('Invalid');
    }
  }

  public async testStartSecondTransaction(withSoC = false) {
    // Check on current transaction
    expect(this.newTransaction).to.not.be.null;
    // Set
    const transactionId = this.newTransaction.id;
    this.transactionStartTime = moment().subtract(1, 'h').toDate();
    // Clear old one
    this.newTransaction = null;
    // Start the 2nd Transaction
    const startTransactionResponse = await this.chargingStationContext.startTransaction(
      this.chargingStationConnector1.connectorId,
      this.transactionStartUser.tags[0].id,
      this.transactionStartMeterValue,
      this.transactionStartTime
    );
    const secondTransactionId = startTransactionResponse.transactionId;
    await this.validateStartedTransaction(
      startTransactionResponse,
      this.chargingStationConnector1,
      this.transactionStartMeterValue,
      this.transactionStartTime);
    // Check if the Transaction exists
    this.newTransaction = (await this.centralUserService.transactionApi.readById(secondTransactionId)).data;
    // Check
    expect(this.newTransaction).to.not.be.null;
    expect(this.newTransaction.id).to.not.equal(transactionId);
  }

  public async testSendMeterValues(withSoC = false, withSignedData = false) {
    // Check on Transaction
    expect(this.newTransaction).to.not.be.null;
    // Current Time matches Transaction one
    this.transactionCurrentTime = moment(this.newTransaction.timestamp).toDate();
    // Start Meter Value matches Transaction one
    let transactionCurrentMeterValue = this.transactionStartMeterValue;
    // Send Transaction.Begin
    let meterValueResponse = await this.chargingStationContext.sendBeginMeterValue(
      this.newTransaction.connectorId,
      this.newTransaction.id,
      transactionCurrentMeterValue,
      this.transactionStartSoC,
      this.transactionSignedData,
      this.transactionCurrentTime,
      withSoC,
      withSignedData);
    if (meterValueResponse) {
      expect(meterValueResponse).to.eql({});
    }
    // Check Transaction
    let transactionValidation = await this.basicTransactionValidation(this.newTransaction.id, this.newTransaction.connectorId, this.newTransaction.meterStart, this.newTransaction.timestamp);
    // Send Meter Values (except the last one which will be used in Stop Transaction)
    for (let index = 0; index <= this.energyActiveImportMeterValues.length - 2; index++) {
      // Set new meter value
      transactionCurrentMeterValue += this.energyActiveImportMeterValues[index];
      // Add time
      this.transactionCurrentTime = moment(this.transactionCurrentTime).add(this.meterValueIntervalSecs, 's').toDate();
      // Send consumption meter value
      meterValueResponse = await this.chargingStationContext.sendConsumptionMeterValue(
        this.newTransaction.connectorId,
        this.newTransaction.id,
        transactionCurrentMeterValue,
        this.transactionCurrentTime,
        withSoC,
        this.socMeterValues[index]);
      expect(meterValueResponse).to.eql({});
      // Check the Consumption
      transactionValidation = await this.basicTransactionValidation(this.newTransaction.id, this.newTransaction.connectorId, this.newTransaction.meterStart, this.newTransaction.timestamp);
      expect(transactionValidation.data).to.deep.include({
        currentInstantWatts: this.powerImportMeterValues[index],
        currentTotalConsumptionWh: (transactionCurrentMeterValue - this.transactionStartMeterValue),
        currentTotalDurationSecs: this.meterValueIntervalSecs * (index + 1),
        currentTotalInactivitySecs: this.totalInactivities[index],
        currentCumulatedPrice: ((transactionCurrentMeterValue - this.transactionStartMeterValue) / 1000) * this.priceKWH,
        currentInactivityStatus : Utils.getInactivityStatusLevel(this.chargingStationContext.getChargingStation(),
          this.newTransaction.connectorId, this.totalInactivities[index]),
      });
      if (withSoC) {
        expect(transactionValidation.data).to.deep.include({
          currentStateOfCharge: this.socMeterValues[index]
        });
      } else {
        expect(transactionValidation.data).to.deep.include({
          stateOfCharge: this.newTransaction.stateOfCharge
        });
      }
    }
    // Send Transaction.End
    meterValueResponse = await this.chargingStationContext.sendEndMeterValue(
      this.newTransaction.connectorId,
      this.newTransaction.id,
      this.energyActiveImportFinalMeterValue,
      this.socFinalMeterValue,
      this.transactionEndSignedData,
      moment(this.transactionCurrentTime),
      withSoC,
      withSignedData);
    if (meterValueResponse) {
      expect(meterValueResponse).to.eql({});
    }
    // Check the Transaction End
    transactionValidation = await this.basicTransactionValidation(this.newTransaction.id, this.newTransaction.connectorId, this.newTransaction.meterStart, this.newTransaction.timestamp);
    if (withSoC) {
      expect(transactionValidation.data).to.deep.include({
        currentStateOfCharge: this.socFinalMeterValue
      });
    } else {
      expect(transactionValidation.data).to.deep.include({
        stateOfCharge: this.newTransaction.stateOfCharge
      });
    }
  }

  public async testStopTransaction(withSoC = false) {
    // Check on Transaction
    expect(this.newTransaction).to.not.be.null;
    expect(this.transactionCurrentTime).to.not.be.null;
    // Set end time
    this.transactionCurrentTime = moment(this.transactionCurrentTime).add(this.meterValueIntervalSecs, 's').toDate();
    // Stop the Transaction
    const stopTransactionResponse = await this.chargingStationContext.stopTransaction(this.newTransaction.id, this.transactionStopUser.tags[0].id, this.energyActiveImportFinalMeterValue, this.transactionCurrentTime);
    // Check
    expect(stopTransactionResponse).to.have.property('idTagInfo');
    expect(stopTransactionResponse.idTagInfo.status).to.equal('Accepted');
    // Set the connector to Available
    this.chargingStationConnector1.status = ChargePointStatus.AVAILABLE;
    this.chargingStationConnector1.timestamp = new Date().toISOString();
    // Update
    const statusResponse = await this.chargingStationContext.setConnectorStatus(this.chargingStationConnector1);
    expect(statusResponse).to.eql({});
    // Check the Transaction
    const transactionValidation = await this.basicTransactionValidation(this.newTransaction.id, this.newTransaction.connectorId, this.newTransaction.meterStart, this.newTransaction.timestamp);
    expect(transactionValidation.data).to.deep['containSubset']({
      'stop': {
        'meterStop': this.energyActiveImportFinalMeterValue,
        'totalConsumptionWh': this.transactionTotalConsumptionWh,
        'totalInactivitySecs': this.transactionTotalInactivitySecs,
        'inactivityStatus': InactivityStatus.INFO,
        'totalDurationSecs': moment.duration(moment(this.transactionCurrentTime).diff(this.newTransaction.timestamp)).asSeconds(),
        'price': this.totalPrice,
        'priceUnit': 'EUR',
        'pricingSource': PricingSettingsType.SIMPLE,
        'roundedPrice': parseFloat(this.totalPrice.toFixed(2)),
        'tagID': this.transactionStopUser.tags[0].id,
        'timestamp': this.transactionCurrentTime.toISOString(),
        'stateOfCharge': (withSoC ? this.socFinalMeterValue : 0),
        'user': {
          'id': this.transactionStopUser.id,
          'name': this.transactionStopUser.name,
          'firstName': this.transactionStopUser.firstName
        }
      }
    });
  }

  public async testTransactionMetrics(withSoC = false, withSignedData = false) {
    // Check on Transaction
    expect(this.newTransaction).to.not.be.null;
    const response = await this.centralUserService.transactionApi.readAllConsumption({ TransactionId: this.newTransaction.id });
    expect(response.status).to.equal(200);
    // Check Headers
    expect(response.data).to.deep['containSubset']({
      'chargeBoxID': this.newTransaction.chargeBoxID,
      'connectorId': this.newTransaction.connectorId,
      'signedData': (withSignedData ? this.transactionSignedData : ''),
      'stop': {
        'price': this.totalPrice,
        'pricingSource': 'simple',
        'roundedPrice': parseFloat(this.totalPrice.toFixed(2)),
        'tagID': this.transactionStopUser.tags[0].id,
        'totalConsumptionWh': this.transactionTotalConsumptionWh,
        'totalInactivitySecs': this.transactionTotalInactivitySecs,
        'inactivityStatus': InactivityStatus.INFO,
        'stateOfCharge': (withSoC ? this.socFinalMeterValue : 0),
        'signedData': (withSignedData ? this.transactionEndSignedData : ''),
        'user': {
          'id': this.transactionStopUser.id,
          'name': this.transactionStopUser.name,
          'firstName': this.transactionStopUser.firstName
        }
      },
      'id': this.newTransaction.id,
      'user': {
        'id': this.transactionStartUser.id,
        'name': this.transactionStartUser.name,
        'firstName': this.transactionStartUser.firstName
      }
    });
    // Init
    const transactionCurrentTime = moment(this.newTransaction.timestamp);
    let transactionCumulatedConsumption = this.transactionStartMeterValue;
    // Check Consumption
    for (let i = 0; i < response.data.values.length; i++) {
      // Get the value
      const value = response.data.values[i];
      // Add time
      transactionCurrentTime.add(this.meterValueIntervalSecs, 's');
      // Sum
      transactionCumulatedConsumption += this.energyActiveImportMeterValues[i];
      // Check
      expect(value).to.include({
        'date': transactionCurrentTime.toISOString(),
        'instantWatts': this.energyActiveImportMeterValues[i] * this.meterValueIntervalSecs,
        'instantAmps': Utils.convertWattToAmp(this.chargingStationContext.getChargingStation(),
          null, this.newTransaction.connectorId, this.energyActiveImportMeterValues[i] * this.meterValueIntervalSecs),
        'cumulatedConsumptionWh': transactionCumulatedConsumption,
        'cumulatedConsumptionAmps': Utils.convertWattToAmp(this.chargingStationContext.getChargingStation(),
          null, this.newTransaction.connectorId, transactionCumulatedConsumption)
      });
      if (withSoC) {
        expect(value).to.include({
          'stateOfCharge': this.socMeterValues[i]
        });
      }
    }
  }

  public async testDeleteTransaction(noAuthorization = false) {
    // Delete the created entity
    expect(this.newTransaction).to.not.be.null;
    let response = await this.transactionStartUserService.transactionApi.delete(this.newTransaction.id);
    if (noAuthorization) {
      expect(response.status).to.equal(560);
      // Transaction must be deleted by Admin user
      response = await this.centralUserService.transactionApi.delete(this.newTransaction.id);
    }
    // Remove from transactions to be deleted
    this.chargingStationContext.removeTransaction(this.newTransaction.id);
    expect(response.status).to.equal(200);
    expect(response.data).to.have.property('status');
    expect(response.data.status).to.be.eql('Success');
    this.newTransaction = null;
  }

  public async testConnectorStatusToStopTransaction() {
    // Check on Transaction
    this.newTransaction = null;
    expect(this.chargingStationConnector1.status).to.eql('Available');

    // Start a new Transaction
    await this.testStartTransaction();
    const transactionId = this.newTransaction.id;
    expect(transactionId).to.not.equal(0);

    this.chargingStationConnector1.status = ChargePointStatus.AVAILABLE;
    this.chargingStationConnector1.errorCode = ChargePointErrorCode.NO_ERROR;
    this.chargingStationConnector1.timestamp = new Date().toISOString();
    // Update Status of Connector 1
    const statusResponse = await this.chargingStationContext.setConnectorStatus(this.chargingStationConnector1);
    // Check
    expect(statusResponse).to.eql({});
    // Send Heartbeat to have an active charger
    await this.chargingStationContext.sendHeartbeat();
    // Now we can test the connector status!
    const foundChargingStation = await this.chargingStationContext.readChargingStation();
    expect(foundChargingStation.status).to.equal(200);
    expect(foundChargingStation.data.id).is.eql(this.chargingStationContext.getChargingStation().id);
    // Check Connector1
    expect(foundChargingStation.data.connectors).to.not.be.null;
    expect(foundChargingStation.data.connectors[0]).to.include({
      status: this.chargingStationConnector1.status,
      errorCode: this.chargingStationConnector1.errorCode
    });
    // Check Transaction
    this.newTransaction = (await this.centralUserService.transactionApi.readById(transactionId)).data;
    expect(this.newTransaction['message']).to.contain('does not exist');
  }

  public async testAuthorizeTagAsInteger() {
    await this.testAuthorize(this.numberTag, 'Accepted');
    await this.testAuthorize(this.numberTag.toString(), 'Accepted');
  }

  public async testAuthorizeInvalidTag() {
    await this.testAuthorize(this.invalidTag, 'Invalid');
    await this.testAuthorize('', 'Invalid');
    await this.testAuthorize(null, 'Invalid');
  }

  public async testAuthorizeUnknownTag() {
    const unknownTag = faker.random.alphaNumeric(8);
    await this.testAuthorize(unknownTag, 'Invalid');
    const usersResponse = await this.centralUserService.userApi.getByTag(unknownTag);
    expect(usersResponse.status).eq(200);
    expect(usersResponse.data.count).eq(1);
    const user = usersResponse.data.result[0];
    this.createdUsers.push(user);
    expect(user.name).eq('Unknown');
    expect(user.firstName).eq('User');
    expect(user.email).eq(`${unknownTag}@e-mobility.com`);
    expect(user.role).eq('B');
    expect(user.tags.length).eq(1);
    expect(user.tags[0].id).eq(unknownTag);
  }

  public async testStartTransactionWithConnectorIdAsString() {
    const response = await this.chargingStationContext.startTransaction(
      this.chargingStationConnector1.connectorId,
      this.numberTag.toString(),
      0,
      this.transactionStartTime
    );
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(response).to.be.transactionValid;
  }

  public async testStartTransactionWithMeterStartGreaterZero() {
    const response = await this.chargingStationContext.startTransaction(
      this.chargingStationConnector1.connectorId,
      this.numberTag.toString(),
      faker.random.number(100000),
      this.transactionStartTime
    );
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(response).to.be.transactionValid;
  }

  public async testStartTransactionWithInvalidTag() {
    let response = await this.chargingStationContext.startTransaction(
      this.chargingStationConnector1.connectorId,
      this.invalidTag,
      0,
      this.transactionStartTime
    );
    expect(response).to.be.transactionStatus('Invalid');
    response = await this.chargingStationContext.startTransaction(
      this.chargingStationConnector1.connectorId,
      '',
      0,
      this.transactionStartTime
    );
    expect(response).to.be.transactionStatus('Invalid');
    response = await this.chargingStationContext.startTransaction(
      this.chargingStationConnector1.connectorId,
      null,
      0,
      this.transactionStartTime
    );
    expect(response).to.be.transactionStatus('Invalid');
  }

  public async testStopTransactionWithoutTransactionData() {
    const startTransactionResponse = await this.chargingStationContext.startTransaction(
      this.chargingStationConnector1.connectorId,
      this.numberTag.toString(),
      this.transactionStartMeterValue,
      this.transactionStartTime
    );
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(startTransactionResponse).to.be.transactionValid;
    const transactionId = startTransactionResponse.transactionId;
    this.transactionCurrentTime = moment().toDate();
    const stopValue = this.transactionStartMeterValue + faker.random.number(100000);
    const stopTransactionResponse = await this.chargingStationContext.stopTransaction(
      transactionId, this.numberTag.toString(), stopValue, this.transactionCurrentTime);
    expect(stopTransactionResponse).to.have.property('idTagInfo');
    expect(stopTransactionResponse.idTagInfo.status).to.equal('Accepted');
  }

  public async testStopTransactionWithTransactionData() {
    const startTransactionResponse = await this.chargingStationContext.startTransaction(
      this.chargingStationConnector1.connectorId,
      this.numberTag.toString(),
      this.transactionStartMeterValue,
      this.transactionStartTime
    );
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(startTransactionResponse).to.be.transactionValid;
    const transactionId = startTransactionResponse.transactionId;
    this.transactionCurrentTime = moment().toDate();
    const stopValue = this.transactionStartMeterValue + faker.random.number(100000);
    let transactionData: OCPPMeterValue[] | OCPP15TransactionData;
    if (this.chargingStationContext.getChargingStation().ocppVersion === OCPPVersion.VERSION_16) {
      transactionData = [
        {
          'timestamp': this.transactionStartTime.toISOString(),
          'sampledValue': [
            {
              'value': this.transactionStartMeterValue.toString(),
              'context': OCPPReadingContext.TRANSACTION_BEGIN,
              'format': OCPPValueFormat.RAW,
              'measurand': OCPPMeasurand.ENERGY_ACTIVE_IMPORT_REGISTER,
              'location': OCPPLocation.OUTLET,
              'unit': OCPPUnitOfMeasure.WATT_HOUR
            }
          ]
        },
        {
          'timestamp': this.transactionCurrentTime.toISOString(),
          'sampledValue': [
            {
              'value': stopValue.toString(),
              'context': OCPPReadingContext.TRANSACTION_END,
              'format': OCPPValueFormat.RAW,
              'measurand': OCPPMeasurand.ENERGY_ACTIVE_IMPORT_REGISTER,
              'location': OCPPLocation.OUTLET,
              'unit': OCPPUnitOfMeasure.WATT_HOUR
            }
          ]
        }
      ];
    // OCPP 1.5
    } else {
      transactionData = {
        'values': [
          {
            'timestamp': this.transactionStartTime.toISOString(),
            'value': {
              '$attributes': {
                'context': OCPPReadingContext.TRANSACTION_BEGIN,
                'format': OCPPValueFormat.RAW,
                'location': OCPPLocation.OUTLET,
                'measurand': OCPPMeasurand.ENERGY_ACTIVE_IMPORT_REGISTER,
                'unit': OCPPUnitOfMeasure.WATT_HOUR
              },
              '$value': this.transactionStartMeterValue.toString(),
            }
          },
          {
            'timestamp': this.transactionCurrentTime.toISOString(),
            'value': {
              '$attributes': {
                'context': OCPPReadingContext.TRANSACTION_END,
                'format': OCPPValueFormat.RAW,
                'location': OCPPLocation.OUTLET,
                'measurand': OCPPMeasurand.ENERGY_ACTIVE_IMPORT_REGISTER,
                'unit': OCPPUnitOfMeasure.WATT_HOUR
              },
              '$value': stopValue.toString()
            }
          }
        ]
      };
    }
    const stopTransactionResponse = await this.chargingStationContext.stopTransaction(transactionId, this.numberTag.toString(), stopValue, this.transactionCurrentTime, transactionData);
    expect(stopTransactionResponse).to.have.property('idTagInfo');
    expect(stopTransactionResponse.idTagInfo.status).to.equal('Accepted');
  }

  public async testStopTransactionWithInvalidTransactionData() {
    const startTransactionResponse = await this.chargingStationContext.startTransaction(
      this.chargingStationConnector1.connectorId,
      this.numberTag.toString(),
      this.transactionStartMeterValue,
      this.transactionStartTime
    );
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(startTransactionResponse).to.be.transactionValid;
    const transactionId = startTransactionResponse.transactionId;
    this.transactionCurrentTime = moment().toDate();
    const stopValue = this.transactionStartMeterValue + faker.random.number(100000);
    let transactionData: OCPPMeterValue[] | OCPP15TransactionData;
    // Provide TransactionData for wrong OCPP Version
    if (this.chargingStationContext.getChargingStation().ocppVersion === OCPPVersion.VERSION_15) {
      transactionData = [
        {
          'timestamp': this.transactionStartTime.toISOString(),
          'sampledValue': [
            {
              'value': this.transactionStartMeterValue.toString(),
              'context': OCPPReadingContext.TRANSACTION_BEGIN,
              'format': OCPPValueFormat.RAW,
              'measurand': OCPPMeasurand.ENERGY_ACTIVE_IMPORT_REGISTER,
              'location': OCPPLocation.OUTLET,
              'unit': OCPPUnitOfMeasure.WATT_HOUR
            }
          ]
        },
        {
          'timestamp': this.transactionCurrentTime.toISOString(),
          'sampledValue': [
            {
              'value': stopValue.toString(),
              'context': OCPPReadingContext.TRANSACTION_END,
              'format': OCPPValueFormat.RAW,
              'measurand': OCPPMeasurand.ENERGY_ACTIVE_IMPORT_REGISTER,
              'location': OCPPLocation.OUTLET,
              'unit': OCPPUnitOfMeasure.WATT_HOUR
            }
          ]
        }
      ];
    // OCPP 1.5
    } else {
      transactionData = {
        'values': [
          {
            'timestamp': this.transactionStartTime.toISOString(),
            'value': {
              '$attributes': {
                'context': OCPPReadingContext.TRANSACTION_BEGIN,
                'format': OCPPValueFormat.RAW,
                'location': OCPPLocation.OUTLET,
                'measurand': OCPPMeasurand.ENERGY_ACTIVE_IMPORT_REGISTER,
                'unit': OCPPUnitOfMeasure.WATT_HOUR
              },
              '$value': this.transactionStartMeterValue.toString(),
            }
          },
          {
            'timestamp': this.transactionCurrentTime.toISOString(),
            'value': {
              '$attributes': {
                'context': OCPPReadingContext.TRANSACTION_END,
                'format': OCPPValueFormat.RAW,
                'location': OCPPLocation.OUTLET,
                'measurand': OCPPMeasurand.ENERGY_ACTIVE_IMPORT_REGISTER,
                'unit': OCPPUnitOfMeasure.WATT_HOUR
              },
              '$value': stopValue.toString()
            }
          }
        ]
      };
    }
    let stopTransactionResponse = await this.chargingStationContext.stopTransaction(transactionId, this.numberTag.toString(), stopValue, this.transactionCurrentTime, transactionData);
    expect(stopTransactionResponse).to.have.property('idTagInfo');
    expect(stopTransactionResponse.idTagInfo.status).to.equal('Invalid');
    // Now stop the transaction without Transaction Data
    stopTransactionResponse = await this.chargingStationContext.stopTransaction(transactionId, this.numberTag.toString(), stopValue, this.transactionCurrentTime);
    expect(stopTransactionResponse).to.have.property('idTagInfo');
    expect(stopTransactionResponse.idTagInfo.status).to.equal('Accepted');
  }

  public async testRetrieveLastRebootDate() {
    const bootNotification = await this.chargingStationContext.sendBootNotification();
    expect(bootNotification).to.not.be.null;
    expect(bootNotification.status).to.eql('Accepted');
    expect(bootNotification).to.have.property('currentTime');
    let chargingStationResponse = await this.chargingStationContext.readChargingStation();
    if (this.chargingStationContext.getChargingStation().ocppVersion === OCPPVersion.VERSION_16) {
      expect(bootNotification.currentTime).to.equal(chargingStationResponse.data.lastReboot);
    } else {
      expect((bootNotification.currentTime as unknown as Date).toISOString()).to.equal(chargingStationResponse.data.lastReboot);
    }
    const bootNotification2 = await this.chargingStationContext.sendBootNotification();
    chargingStationResponse = await this.chargingStationContext.readChargingStation();
    if (this.chargingStationContext.getChargingStation().ocppVersion === OCPPVersion.VERSION_16) {
      expect(bootNotification2.currentTime).to.equal(chargingStationResponse.data.lastReboot);
    } else {
      expect((bootNotification2.currentTime as unknown as Date).toISOString()).to.equal(chargingStationResponse.data.lastReboot);
    }
    expect(bootNotification.currentTime).to.not.equal(bootNotification2.currentTime);
    if (this.chargingStationContext.getChargingStation().ocppVersion === OCPPVersion.VERSION_16) {
      expect(new Date(bootNotification.currentTime)).to.beforeTime(new Date(bootNotification2.currentTime));
    } else {
      expect(bootNotification.currentTime).to.beforeTime(new Date(bootNotification2.currentTime));
    }
  }

  public async testTransactionIgnoringClockMeterValues() {
    const meterStart = 0;
    let meterValue = meterStart;
    const currentTime = moment();
    const startTransactionResponse = await this.chargingStationContext.startTransaction(
      this.chargingStationConnector1.connectorId,
      this.numberTag.toString(),
      meterValue,
      currentTime.toDate()
    );
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(startTransactionResponse).to.be.transactionValid;
    const transactionId = startTransactionResponse.transactionId;
    let meterValueResponse = await this.chargingStationContext.sendConsumptionMeterValue(
      this.chargingStationConnector1.connectorId,
      transactionId,
      meterValue += 300,
      currentTime.add(1, 'minute').clone().toDate()
    );
    expect(meterValueResponse).to.eql({});
    meterValueResponse = await this.chargingStationContext.sendConsumptionMeterValue(
      this.chargingStationConnector1.connectorId,
      transactionId,
      meterValue += 300,
      currentTime.add(1, 'minute').clone().toDate()
    );
    expect(meterValueResponse).to.eql({});
    meterValueResponse = await this.chargingStationContext.sendConsumptionMeterValue(
      this.chargingStationConnector1.connectorId,
      transactionId,
      meterValue += 300,
      currentTime.add(1, 'minute').clone().toDate()
    );
    expect(meterValueResponse).to.eql({});
    meterValueResponse = await this.chargingStationContext.sendClockMeterValue(
      this.chargingStationConnector1.connectorId,
      transactionId,
      0,
      currentTime.clone().toDate()
    );
    expect(meterValueResponse).to.eql({});
    meterValueResponse = await this.chargingStationContext.sendConsumptionMeterValue(
      this.chargingStationConnector1.connectorId,
      transactionId,
      meterValue += 300,
      currentTime.add(1, 'minute').clone().toDate()
    );
    expect(meterValueResponse).to.eql({});
    const stopTransactionResponse = await this.chargingStationContext.stopTransaction(
      transactionId,
      this.numberTag.toString(),
      meterValue, currentTime.add(1, 'minute').clone().toDate()
    );
    expect(stopTransactionResponse).to.have.property('idTagInfo');
    expect(stopTransactionResponse.idTagInfo.status).to.equal('Accepted');
    const transaction = await this.centralUserService.transactionApi.readById(transactionId);
    expect(transaction.status).to.equal(200);
    expect(transaction.data).to.deep['containSubset']({
      id: transactionId,
      meterStart: meterStart,
      stop: {
        totalConsumptionWh: meterValue - meterStart,
        totalInactivitySecs: 60,
        inactivityStatus: InactivityStatus.INFO
      }
    });
  }

  private async createUser(user = Factory.user.build()) {
    const createdUser = await this.centralUserService.createEntity(this.centralUserService.userApi, user);
    return createdUser;
  }

  private async testAuthorize(tagId, expectedStatus) {
    const response = await this.chargingStationContext.authorize(tagId);
    // Check
    expect(response).to.have.property('idTagInfo');
    expect(response.idTagInfo.status).to.equal(expectedStatus);
  }

  private async validateStartedTransaction(response, chargingStationConnector, startMeterValue, startTime) {
    expect(response).to.have.property('idTagInfo');
    expect(response.idTagInfo.status).to.equal('Accepted');
    expect(response).to.have.property('transactionId');
    expect(response.transactionId).to.not.equal(0);
    const transactionId = response.transactionId;
    // Update connector status
    chargingStationConnector.status = 'Occupied';
    chargingStationConnector.timestamp = new Date().toISOString();
    const statusNotificationResponse = await this.chargingStationContext.setConnectorStatus(chargingStationConnector);
    expect(statusNotificationResponse).to.eql({});
    const basicTransactionValidation = await this.basicTransactionValidation(transactionId, chargingStationConnector.connectorId, startMeterValue, startTime.toISOString());
    expect(basicTransactionValidation.data).to.deep.include({
      currentInstantWatts: 0,
      currentCumulatedPrice: 0,
      currentStateOfCharge: 0,
      currentTotalConsumptionWh: 0,
      currentTotalInactivitySecs: 0,
      currentInactivityStatus: InactivityStatus.INFO,
      price: 0,
      roundedPrice: 0,
    });
  }

  private async basicTransactionValidation(transactionId: number, connectorId: number, meterStart: number, timestamp: Date) {
    const transactionResponse = await this.centralUserService.transactionApi.readById(transactionId);
    expect(transactionResponse.status).to.equal(200);
    expect(transactionResponse.data).to.deep['containSubset']({
      'id': transactionId,
      'timestamp': timestamp,
      'chargeBoxID': this.chargingStationContext.getChargingStation().id,
      'connectorId': connectorId,
      'tagID': this.transactionStartUser.tags[0].id,
      'meterStart': meterStart,
      'userID': this.transactionStartUser.id,
      'siteAreaID': this.chargingStationContext.getChargingStation().siteAreaID,
      'siteID': this.chargingStationContext.getChargingStation().siteArea.siteID,
      'user': {
        'id': this.transactionStartUser.id,
        'name': this.transactionStartUser.name,
        'firstName': this.transactionStartUser.firstName
      }
    });
    return transactionResponse;
  }

}
