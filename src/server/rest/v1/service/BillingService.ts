import { Action, Entity } from '../../../../types/Authorization';
import { BillingInvoiceStatus, BillingOperationResult, BillingPaymentMethod, BillingUserSynchronizeAction } from '../../../../types/Billing';
import { HTTPAuthError, HTTPError } from '../../../../types/HTTPError';
import { NextFunction, Request, Response } from 'express';

import AppAuthError from '../../../../exception/AppAuthError';
import AppError from '../../../../exception/AppError';
import Authorizations from '../../../../authorization/Authorizations';
import BillingFactory from '../../../../integration/billing/BillingFactory';
import BillingSecurity from './security/BillingSecurity';
import { BillingSettings } from '../../../../types/Setting';
import BillingStorage from '../../../../storage/mongodb/BillingStorage';
import BillingValidator from '../validator/BillingValidator';
import Constants from '../../../../utils/Constants';
import { DataResult } from '../../../../types/DataResult';
import LockingHelper from '../../../../locking/LockingHelper';
import LockingManager from '../../../../locking/LockingManager';
import Logging from '../../../../utils/Logging';
import { ServerAction } from '../../../../types/Server';
import SettingStorage from '../../../../storage/mongodb/SettingStorage';
import { StatusCodes } from 'http-status-codes';
import TenantComponents from '../../../../types/TenantComponents';
import User from '../../../../types/User';
import UserStorage from '../../../../storage/mongodb/UserStorage';
import UtilsService from './UtilsService';
import fs from 'fs';

const MODULE_NAME = 'BillingService';

export default class BillingService {

  public static async handleCheckBillingConnection(action: ServerAction, req: Request, res: Response, next: NextFunction): Promise<void> {
    // Check if component is active
    UtilsService.assertComponentIsActiveFromToken(req.user, TenantComponents.BILLING,
      Action.CHECK_CONNECTION, Entity.BILLING, MODULE_NAME, 'handleCheckBillingConnection');
    if (!await Authorizations.canCheckBillingConnection(req.user)) {
      throw new AppAuthError({
        errorCode: HTTPAuthError.FORBIDDEN,
        user: req.user,
        entity: Entity.BILLING, action: Action.CHECK_CONNECTION,
        module: MODULE_NAME, method: 'handleCheckBillingConnection',
      });
    }
    const billingImpl = await BillingFactory.getBillingImpl(req.user.tenantID);
    if (!billingImpl) {
      throw new AppError({
        source: Constants.CENTRAL_SERVER,
        errorCode: HTTPError.GENERAL_ERROR,
        message: 'Billing service is not configured',
        module: MODULE_NAME, method: 'handleCheckBillingConnection',
        action: action,
        user: req.user
      });
    }
    try {
      // Check
      await billingImpl.checkConnection();
      // Ok
      res.json(Object.assign({ connectionIsValid: true }, Constants.REST_RESPONSE_SUCCESS));
    } catch (error) {
      // Ko
      await Logging.logError({
        tenantID: req.user.tenantID,
        user: req.user,
        module: MODULE_NAME, method: 'handleCheckBillingConnection',
        message: 'Billing connection failed',
        action: action,
        detailedMessages: { error: error.message, stack: error.stack }
      });
      res.json(Object.assign({ connectionIsValid: false }, Constants.REST_RESPONSE_SUCCESS));
    }
    next();
  }

  public static async handleSynchronizeUsers(action: ServerAction, req: Request, res: Response, next: NextFunction): Promise<void> {
    if (!await Authorizations.canSynchronizeUsersBilling(req.user)) {
      throw new AppAuthError({
        errorCode: HTTPAuthError.FORBIDDEN,
        user: req.user,
        entity: Entity.USERS, action: Action.SYNCHRONIZE_BILLING_USERS,
        module: MODULE_NAME, method: 'handleSynchronizeUsers',
      });
    }
    // Check if component is active
    UtilsService.assertComponentIsActiveFromToken(req.user, TenantComponents.BILLING,
      Action.SYNCHRONIZE_BILLING_USERS, Entity.USERS, MODULE_NAME, 'handleSynchronizeUsers');
    const billingImpl = await BillingFactory.getBillingImpl(req.user.tenantID);
    if (!billingImpl) {
      throw new AppError({
        source: Constants.CENTRAL_SERVER,
        errorCode: HTTPError.GENERAL_ERROR,
        message: 'Billing service is not configured',
        module: MODULE_NAME, method: 'handleSynchronizeUsers',
        action: action,
        user: req.user
      });
    }
    // Get the lock
    let synchronizeAction: BillingUserSynchronizeAction = {
      inError: 0,
      inSuccess: 0,
    };
    const billingLock = await LockingHelper.createBillingSyncUsersLock(req.user.tenantID);
    if (billingLock) {
      try {
        // Sync users
        synchronizeAction = await billingImpl.synchronizeUsers();
      } finally {
        // Release the lock
        await LockingManager.release(billingLock);
      }
    } else {
      throw new AppError({
        source: Constants.CENTRAL_SERVER,
        errorCode: HTTPError.GENERAL_ERROR,
        message: 'Cannot acquire lock',
        module: MODULE_NAME, method: 'handleSynchronizeUsers',
        action: action,
        user: req.user
      });
    }
    // Ok
    res.json(Object.assign(synchronizeAction, Constants.REST_RESPONSE_SUCCESS));
    next();
  }

  public static async handleSynchronizeUser(action: ServerAction, req: Request, res: Response, next: NextFunction): Promise<void> {
    const filteredRequest = BillingSecurity.filterSynchronizeUserRequest(req.body);
    if (!await Authorizations.canSynchronizeUserBilling(req.user)) {
      throw new AppAuthError({
        errorCode: HTTPAuthError.FORBIDDEN,
        user: req.user,
        entity: Entity.USER, action: Action.SYNCHRONIZE_BILLING_USER,
        module: MODULE_NAME, method: 'handleSynchronizeUser',
      });
    }
    // Check if component is active
    UtilsService.assertComponentIsActiveFromToken(req.user, TenantComponents.BILLING,
      Action.SYNCHRONIZE_BILLING_USERS, Entity.USER, MODULE_NAME, 'handleSynchronizeUser');
    const billingImpl = await BillingFactory.getBillingImpl(req.user.tenantID);
    if (!billingImpl) {
      throw new AppError({
        source: Constants.CENTRAL_SERVER,
        errorCode: HTTPError.GENERAL_ERROR,
        message: 'Billing service is not configured',
        module: MODULE_NAME, method: 'handleSynchronizeUser',
        action: action,
        user: req.user
      });
    }
    // Get user
    const userToSynchronize = await UserStorage.getUser(req.user.tenantID, filteredRequest.id);
    UtilsService.assertObjectExists(action, userToSynchronize, `User ID '${filteredRequest.id}' does not exist`,
      MODULE_NAME, 'handleSynchronizeUser', req.user);
    // Get the lock
    const billingLock = await LockingHelper.createBillingSyncUsersLock(req.user.tenantID);
    if (billingLock) {
      try {
        // Sync user
        await billingImpl.synchronizeUser(userToSynchronize);
      } finally {
        // Release the lock
        await LockingManager.release(billingLock);
      }
    } else {
      throw new AppError({
        source: Constants.CENTRAL_SERVER,
        errorCode: HTTPError.GENERAL_ERROR,
        message: 'Cannot acquire lock',
        module: MODULE_NAME, method: 'handleSynchronizeUser',
        action: action,
        user: req.user
      });
    }
    // Ok
    res.json(Constants.REST_RESPONSE_SUCCESS);
    next();
  }

  public static async handleForceSynchronizeUser(action: ServerAction, req: Request, res: Response, next: NextFunction): Promise<void> {
    const filteredRequest = BillingSecurity.filterSynchronizeUserRequest(req.body);
    if (!await Authorizations.canSynchronizeUserBilling(req.user)) {
      throw new AppAuthError({
        errorCode: HTTPAuthError.FORBIDDEN,
        user: req.user,
        entity: Entity.USER, action: Action.SYNCHRONIZE_BILLING_USER,
        module: MODULE_NAME, method: 'handleForceSynchronizeUser',
      });
    }
    // Check if component is active
    UtilsService.assertComponentIsActiveFromToken(req.user, TenantComponents.BILLING,
      Action.SYNCHRONIZE_BILLING_USER, Entity.USER, MODULE_NAME, 'handleForceSynchronizeUser');
    const billingImpl = await BillingFactory.getBillingImpl(req.user.tenantID);
    if (!billingImpl) {
      throw new AppError({
        source: Constants.CENTRAL_SERVER,
        errorCode: HTTPError.GENERAL_ERROR,
        message: 'Billing service is not configured',
        module: MODULE_NAME, method: 'handleForceSynchronizeUser',
        action: action,
        user: req.user
      });
    }
    // Get user
    const user = await UserStorage.getUser(req.user.tenantID, filteredRequest.id);
    UtilsService.assertObjectExists(action, user, `User ID '${filteredRequest.id}' does not exist`,
      MODULE_NAME, 'handleSynchronizeUser', req.user);
    // Get the User lock
    const billingLock = await LockingHelper.createBillingSyncUsersLock(req.user.tenantID);
    if (billingLock) {
      try {
        await billingImpl.forceSynchronizeUser(user);
      } finally {
        await LockingManager.release(billingLock);
      }
    } else {
      throw new AppError({
        source: Constants.CENTRAL_SERVER,
        errorCode: HTTPError.GENERAL_ERROR,
        message: 'Cannot acquire lock',
        module: MODULE_NAME, method: 'handleSynchronizeUser',
        action: action,
        user: req.user
      });
    }
    // Ok
    res.json(Constants.REST_RESPONSE_SUCCESS);
    next();
  }

  public static async handleGetBillingTaxes(action: ServerAction, req: Request, res: Response, next: NextFunction): Promise<void> {
    if (!await Authorizations.canReadTaxesBilling(req.user)) {
      throw new AppAuthError({
        errorCode: HTTPAuthError.FORBIDDEN,
        user: req.user,
        entity: Entity.TAXES, action: Action.LIST,
        module: MODULE_NAME, method: 'handleGetBillingTaxes',
      });
    }
    // Check if component is active
    UtilsService.assertComponentIsActiveFromToken(req.user, TenantComponents.BILLING,
      Action.LIST, Entity.TAXES, MODULE_NAME, 'handleGetBillingTaxes');
    // Get Billing implementation from factory
    const billingImpl = await BillingFactory.getBillingImpl(req.user.tenantID);
    if (!billingImpl) {
      throw new AppError({
        source: Constants.CENTRAL_SERVER,
        errorCode: HTTPError.GENERAL_ERROR,
        message: 'Billing service is not configured',
        module: MODULE_NAME, method: 'handleGetBillingTaxes',
        action: action,
        user: req.user
      });
    }
    // Get taxes
    const taxes = await billingImpl.getTaxes();
    // Return
    res.json(taxes);
    next();
  }

  public static async handleGetInvoices(action: ServerAction, req: Request, res: Response, next: NextFunction): Promise<void> {
    // Check if component is active
    UtilsService.assertComponentIsActiveFromToken(req.user, TenantComponents.BILLING,
      Action.LIST, Entity.INVOICES, MODULE_NAME, 'handleGetInvoices');
    if (!await Authorizations.canListInvoicesBilling(req.user)) {
      throw new AppAuthError({
        errorCode: HTTPAuthError.FORBIDDEN,
        user: req.user,
        entity: Entity.INVOICES, action: Action.LIST,
        module: MODULE_NAME, method: 'handleGetInvoices',
      });
    }
    // Check Users
    let userProject: string[] = [];
    if (await Authorizations.canListUsers(req.user)) {
      userProject = [ 'userID', 'user.id', 'user.name', 'user.firstName', 'user.email' ];
    }
    // Filter
    const filteredRequest = BillingSecurity.filterGetInvoicesRequest(req.query);
    // Get invoices
    const invoices = await BillingStorage.getInvoices(req.user.tenantID,
      {
        userIDs: !Authorizations.isAdmin(req.user) ? [req.user.id] : (filteredRequest.UserID ? filteredRequest.UserID.split('|') : null),
        invoiceStatus: filteredRequest.Status ? filteredRequest.Status.split('|') as BillingInvoiceStatus[] : null,
        search: filteredRequest.Search ? filteredRequest.Search : null,
        startDateTime: filteredRequest.StartDateTime ? filteredRequest.StartDateTime : null,
        endDateTime: filteredRequest.EndDateTime ? filteredRequest.EndDateTime : null,
      },
      {
        limit: filteredRequest.Limit,
        skip: filteredRequest.Skip,
        sort: filteredRequest.SortFields,
        onlyRecordCount: filteredRequest.OnlyRecordCount
      },
      [
        'id', 'number', 'status', 'amount', 'createdOn', 'currency', 'downloadable', 'sessions',
        ...userProject
      ]);
    // Return
    res.json(invoices);
    next();
  }

  public static async handleGetInvoice(action: ServerAction, req: Request, res: Response, next: NextFunction): Promise<void> {
    // Check if component is active
    UtilsService.assertComponentIsActiveFromToken(req.user, TenantComponents.BILLING,
      Action.LIST, Entity.INVOICES, MODULE_NAME, 'handleGetInvoice');
    // Filter
    const filteredRequest = BillingSecurity.filterGetInvoiceRequest(req.query);
    UtilsService.assertIdIsProvided(action, filteredRequest.ID, MODULE_NAME, 'handleGetInvoice', req.user);
    // Check Users
    let userProject: string[] = [];
    if (await Authorizations.canListUsers(req.user)) {
      userProject = [ 'userID', 'user.id', 'user.name', 'user.firstName', 'user.email' ];
    }
    // Get invoice
    const invoice = await BillingStorage.getInvoice(req.user.tenantID, filteredRequest.ID,
      [
        'id', 'number', 'status', 'amount', 'createdOn', 'currency', 'downloadable', 'sessions',
        ...userProject
      ]);
    UtilsService.assertObjectExists(action, invoice, `Invoice ID '${filteredRequest.ID}' does not exist`, MODULE_NAME, 'handleGetInvoice', req.user);
    // Check auth
    if (!await Authorizations.canReadInvoiceBilling(req.user, invoice.userID)) {
      throw new AppAuthError({
        errorCode: HTTPAuthError.FORBIDDEN,
        user: req.user,
        entity: Entity.INVOICE, action: Action.READ,
        module: MODULE_NAME, method: 'handleGetInvoice',
      });
    }
    // Return
    res.json(invoice);
    next();
  }

  public static async handleSynchronizeInvoices(action: ServerAction, req: Request, res: Response, next: NextFunction): Promise<void> {
    if (!await Authorizations.canSynchronizeInvoicesBilling(req.user)) {
      throw new AppAuthError({
        errorCode: HTTPAuthError.FORBIDDEN,
        user: req.user,
        entity: Entity.INVOICES, action: Action.SYNCHRONIZE,
        module: MODULE_NAME, method: 'handleSynchronizeInvoices',
      });
    }
    // Check if component is active
    UtilsService.assertComponentIsActiveFromToken(req.user, TenantComponents.BILLING,
      Action.SYNCHRONIZE, Entity.INVOICES, MODULE_NAME, 'handleSynchronizeInvoices');
    // Check user
    let user: User;
    if (!Authorizations.isAdmin(req.user)) {
      // Get the User
      user = await UserStorage.getUser(req.user.tenantID, req.user.id);
      UtilsService.assertObjectExists(action, user, `User ID '${req.user.id}' does not exist`,
        MODULE_NAME, 'handleSynchronizeUserInvoices', req.user);
    }
    // Get the billing impl
    const billingImpl = await BillingFactory.getBillingImpl(req.user.tenantID);
    if (!billingImpl) {
      throw new AppError({
        source: Constants.CENTRAL_SERVER,
        errorCode: HTTPError.GENERAL_ERROR,
        message: 'Billing service is not configured',
        module: MODULE_NAME, method: 'handleSynchronizeInvoices',
        action: action,
        user: req.user
      });
    }
    let synchronizeAction: BillingUserSynchronizeAction = {
      inError: 0,
      inSuccess: 0,
    };
    // Get the Invoice lock
    const billingLock = await LockingHelper.createBillingSyncInvoicesLock(req.user.tenantID);
    if (billingLock) {
      try {
        // Sync invoices
        synchronizeAction = await billingImpl.synchronizeInvoices(user);
      } finally {
        // Release the lock
        await LockingManager.release(billingLock);
      }
    } else {
      throw new AppError({
        source: Constants.CENTRAL_SERVER,
        errorCode: HTTPError.GENERAL_ERROR,
        message: 'Cannot acquire lock',
        module: MODULE_NAME, method: 'handleSynchronizeUserInvoices',
        action: action,
        user: req.user
      });
    }
    // Ok
    res.json(Object.assign(synchronizeAction, Constants.REST_RESPONSE_SUCCESS));
    next();
  }

  public static async handleForceSynchronizeUserInvoices(action: ServerAction, req: Request, res: Response, next: NextFunction): Promise<void> {
    if (!await Authorizations.canSynchronizeInvoicesBilling(req.user)) {
      throw new AppAuthError({
        errorCode: HTTPAuthError.FORBIDDEN,
        user: req.user,
        entity: Entity.INVOICES, action: Action.SYNCHRONIZE,
        module: MODULE_NAME, method: 'handleForceSynchronizeUserInvoices',
      });
    }
    // Check if component is active
    UtilsService.assertComponentIsActiveFromToken(req.user, TenantComponents.BILLING,
      Action.SYNCHRONIZE, Entity.INVOICES, MODULE_NAME, 'handleForceSynchronizeUserInvoices');
    const billingImpl = await BillingFactory.getBillingImpl(req.user.tenantID);
    if (!billingImpl) {
      throw new AppError({
        source: Constants.CENTRAL_SERVER,
        errorCode: HTTPError.GENERAL_ERROR,
        message: 'Billing service is not configured',
        module: MODULE_NAME, method: 'handleForceSynchronizeUserInvoices',
        action: action,
        user: req.user
      });
    }
    const filteredRequest = BillingSecurity.filterForceSynchronizeUserInvoicesRequest(req.body);
    // Get the User
    const user = await UserStorage.getUser(req.user.tenantID, filteredRequest.userID);
    UtilsService.assertObjectExists(action, user, `User ID '${filteredRequest.userID}' does not exist`,
      MODULE_NAME, 'handleForceSynchronizeUserInvoices', req.user);
    // Get the Invoice lock
    let synchronizeAction: BillingUserSynchronizeAction = {
      inError: 0,
      inSuccess: 0,
    };
    const billingLock = await LockingHelper.createBillingSyncInvoicesLock(req.user.tenantID);
    if (billingLock) {
      try {
        // Sync invoices
        synchronizeAction = await billingImpl.synchronizeInvoices(user);
      } finally {
        // Release the lock
        await LockingManager.release(billingLock);
      }
    } else {
      throw new AppError({
        source: Constants.CENTRAL_SERVER,
        errorCode: HTTPError.GENERAL_ERROR,
        message: 'Cannot acquire lock',
        module: MODULE_NAME, method: 'handleForceSynchronizeUserInvoices',
        action: action,
        user: req.user
      });
    }
    // Ok
    res.json(Object.assign(synchronizeAction, Constants.REST_RESPONSE_SUCCESS));
    next();
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars, @typescript-eslint/require-await
  public static async handleCreateTransactionInvoice(action: ServerAction, req: Request, res: Response, next: NextFunction): Promise<void> {
    // TODO - no use-case for this endpoint so far!
    throw new Error('Method not implemented.');
    // // Check if component is active
    // UtilsService.assertComponentIsActiveFromToken(req.user, TenantComponents.BILLING,
    //   Action.CREATE, Entity.INVOICE, MODULE_NAME, 'handleCreateTransactionInvoice');
    // // Check Auth
    // if (!await Authorizations.canCreateTransactionInvoice(req.user)) {
    //   throw new AppAuthError({
    //     errorCode: HTTPAuthError.FORBIDDEN,
    //     user: req.user,
    //     entity: Entity.INVOICE, action: Action.CREATE,
    //     module: MODULE_NAME, method: 'handleCreateTransactionInvoice',
    //   });
    // }
    // const filteredRequest = BillingSecurity.filterLinkTransactionToInvoiceRequest(req.body);
    // // Get Billing impl
    // const billingImpl = await BillingFactory.getBillingImpl(req.user.tenantID);
    // if (!billingImpl) {
    //   throw new AppError({
    //     source: Constants.CENTRAL_SERVER,
    //     errorCode: HTTPError.GENERAL_ERROR,
    //     message: 'Billing service is not configured',
    //     module: MODULE_NAME, method: 'handleCreateTransactionInvoice',
    //     action: action,
    //     user: req.user
    //   });
    // }
    // // Get the Transaction
    // const transaction = await TransactionStorage.getTransaction(req.user.tenantID,
    //   Utils.convertToInt(filteredRequest.transactionID));
    // UtilsService.assertObjectExists(action, transaction, `Transaction ID '${filteredRequest.transactionID}' does not exist`,
    //   MODULE_NAME, 'handleCreateTransactionInvoice', req.user);
    // Create an invoice for the transaction
    // ----------------------------------------------------------------------
    // TODO - Rethink that part!
    // Calling StopTransaction without calling startTransaction may have
    // unpredictable side-effects.
    // ----------------------------------------------------------------------
    // const billingDataStop = await billingImpl.stopTransaction(transaction);
    // // Update transaction billing data
    // if (transaction.billingData) {
    //   transaction.billingData.stop = billingDataStop;
    //   transaction.billingData.lastUpdate = new Date();
    // }
    // // Save it
    // await TransactionStorage.saveTransaction(req.user.tenantID, transaction);
    // // Ok
    // await Logging.logInfo({
    //   tenantID: req.user.tenantID,
    //   user: req.user, actionOnUser: transaction.userID,
    //   module: MODULE_NAME, method: 'handleCreateTransactionInvoice',
    //   message: `Transaction ID '${transaction.id}' has been billed successfully`,
    //   action: action,
    // });
    // Ok
    // res.json(Object.assign(Constants.REST_RESPONSE_SUCCESS));
    // next();
  }

  public static async handleBillingSetupPaymentMethod(action: ServerAction, req: Request, res: Response, next: NextFunction): Promise<void> {
    // Check if component is active
    UtilsService.assertComponentIsActiveFromToken(req.user, TenantComponents.BILLING,
      Action.BILLING_SETUP_PAYMENT_METHOD, Entity.BILLING, MODULE_NAME, 'handleSetupSetupPaymentMethod');
    // Filter
    const filteredRequest = BillingSecurity.filterSetupPaymentMethodRequest(req.body);
    if (!await Authorizations.canCreatePaymentMethod(req.user, filteredRequest.userID)) {
      throw new AppAuthError({
        errorCode: HTTPAuthError.FORBIDDEN,
        user: req.user,
        action: Action.CREATE, entity: Entity.PAYMENT_METHOD,
        module: MODULE_NAME, method: 'handleBillingSetupPaymentMethod'
      });
    }
    // Get the billing impl
    const billingImpl = await BillingFactory.getBillingImpl(req.user.tenantID);
    if (!billingImpl) {
      throw new AppError({
        source: Constants.CENTRAL_SERVER,
        errorCode: HTTPError.GENERAL_ERROR,
        message: 'Billing service is not configured',
        module: MODULE_NAME, method: 'handleBillingSetupPaymentMethod',
        action: action,
        user: req.user
      });
    }
    // Get user - ACHTUNG user !== req.user
    const user: User = await UserStorage.getUser(req.user.tenantID, filteredRequest.userID);
    UtilsService.assertObjectExists(action, user, `User ID '${filteredRequest.userID}' does not exist`,
      MODULE_NAME, 'handleSetupPaymentMethod', req.user);
    // Invoke the billing implementation
    const paymentMethodId: string = filteredRequest.paymentMethodId;
    const operationResult: BillingOperationResult = await billingImpl.setupPaymentMethod(user, paymentMethodId);
    if (operationResult) {
      console.log(operationResult);
    }
    res.json(operationResult);
    next();
  }

  public static async handleBillingGetPaymentMethods(action: ServerAction, req: Request, res: Response, next: NextFunction): Promise<void> {
    // Filter
    const filteredRequest = BillingSecurity.filterPaymentMethodsRequest(req.query);
    // Check if component is active
    UtilsService.assertComponentIsActiveFromToken(req.user, TenantComponents.BILLING,
      Action.BILLING_PAYMENT_METHODS, Entity.BILLING, MODULE_NAME, 'handleBillingGetPaymentMethods');
    if (!await Authorizations.canListPaymentMethod(req.user)) {
      throw new AppAuthError({
        errorCode: HTTPAuthError.FORBIDDEN,
        user: req.user,
        action: Action.CREATE, entity: Entity.PAYMENT_METHOD,
        module: MODULE_NAME, method: 'handleBillingGetPaymentMethods'
      });
    }
    // Get the billing impl
    const billingImpl = await BillingFactory.getBillingImpl(req.user.tenantID);
    if (!billingImpl) {
      throw new AppError({
        source: Constants.CENTRAL_SERVER,
        errorCode: HTTPError.GENERAL_ERROR,
        message: 'Billing service is not configured',
        module: MODULE_NAME, method: 'handleBillingGetPaymentMethods',
        action: action,
        user: req.user
      });
    }
    // Get user - ACHTUNG user !== req.user
    const user: User = await UserStorage.getUser(req.user.tenantID, filteredRequest.userID);
    UtilsService.assertObjectExists(action, user, `User ID '${filteredRequest.userID}' does not exist`,
      MODULE_NAME, 'handleBillingGetPaymentMethods', req.user);
    // Invoke the billing implementation
    const paymentMethods: BillingPaymentMethod[] = await billingImpl.getPaymentMethods(user);
    const dataResult: DataResult<BillingPaymentMethod> = {
      count: paymentMethods.length,
      result: paymentMethods
    };
    res.json(dataResult);
    next();
  }

  public static async handleBillingDeletePaymentMethod(action: ServerAction, req: Request, res: Response, next: NextFunction): Promise<void> {
    // Filter
    const filteredRequest = BillingSecurity.filterDeletePaymentMethodRequest(req.body);
    // Check if component is active
    UtilsService.assertComponentIsActiveFromToken(req.user, TenantComponents.BILLING,
      Action.BILLING_PAYMENT_METHODS, Entity.BILLING, MODULE_NAME, 'handleBillingDeletePaymentMethod');
    if (!await Authorizations.canDeletePaymentMethod(req.user)) {
      throw new AppAuthError({
        errorCode: HTTPAuthError.FORBIDDEN,
        user: req.user,
        action: Action.DELETE, entity: Entity.PAYMENT_METHOD,
        module: MODULE_NAME, method: 'handleBillingDeletePaymentMethod'
      });
    }
    // Get the billing impl
    const billingImpl = await BillingFactory.getBillingImpl(req.user.tenantID);
    if (!billingImpl) {
      throw new AppError({
        source: Constants.CENTRAL_SERVER,
        errorCode: HTTPError.GENERAL_ERROR,
        message: 'Billing service is not configured',
        module: MODULE_NAME, method: 'handleBillingDeletePaymentMethod',
        action: action,
        user: req.user
      });
    }
    const userID = filteredRequest.userID;
    const user: User = await UserStorage.getUser(req.user.tenantID, userID);
    UtilsService.assertObjectExists(action, user, `User ID '${userID}' does not exist`,
      MODULE_NAME, 'handleBillingDeletePaymentMethod', req.user);
    // Invoke the billing implementation
    await billingImpl.deletePaymentMethod(user, filteredRequest.paymentMethodId);
    // Log
    await Logging.logSecurityInfo({
      tenantID: req.user.tenantID,
      user: req.user, module: MODULE_NAME, method: 'handleDeleteSite',
      message: `Payment Method '${filteredRequest.paymentMethodId}' has been deleted successfully`,
      action: action
    });
    // Ok
    res.json(Constants.REST_RESPONSE_SUCCESS);
    next();
  }

  public static async handleDownloadInvoice(action: ServerAction, req: Request, res: Response, next: NextFunction): Promise<void> {
    // Check if component is active
    UtilsService.assertComponentIsActiveFromToken(req.user, TenantComponents.BILLING,
      Action.DOWNLOAD, Entity.BILLING, MODULE_NAME, 'handleDownloadInvoice');
    // Filter
    const filteredRequest = BillingSecurity.filterDownloadInvoiceRequest(req.query);
    // Get the Invoice
    const billingInvoice = await BillingStorage.getInvoice(req.user.tenantID, filteredRequest.ID);
    UtilsService.assertObjectExists(action, billingInvoice, `Invoice ID '${filteredRequest.ID}' does not exist`,
      MODULE_NAME, 'handleDownloadInvoice', req.user);
    // Check Auth
    if (!await Authorizations.canDownloadInvoiceBilling(req.user, billingInvoice.userID)) {
      throw new AppAuthError({
        errorCode: HTTPAuthError.FORBIDDEN,
        user: req.user,
        entity: Entity.INVOICE, action: Action.DOWNLOAD,
        module: MODULE_NAME, method: 'handleDownloadInvoice',
      });
    }
    // Get the billing impl
    const billingImpl = await BillingFactory.getBillingImpl(req.user.tenantID);
    if (!billingImpl) {
      throw new AppError({
        source: Constants.CENTRAL_SERVER,
        errorCode: HTTPError.GENERAL_ERROR,
        message: 'Billing service is not configured',
        module: MODULE_NAME, method: 'handleDownloadInvoice',
        action: action,
        user: req.user
      });
    }

    const buffer = await billingImpl.downloadInvoiceDocument(billingInvoice);
    if (!billingInvoice.number || !buffer) {
      throw new AppError({
        source: Constants.CENTRAL_SERVER,
        errorCode: HTTPError.GENERAL_ERROR,
        message: 'Invoice document not found',
        module: MODULE_NAME, method: 'handleDownloadInvoice',
        action: action,
        user: req.user
      });
    }
    const fileName = 'invoice_' + billingInvoice.number + '.pdf';
    res.attachment(fileName);
    res.setHeader('Content-Type', 'application/pdf');
    res.end(buffer, 'binary');
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars, @typescript-eslint/require-await
  public static async handleBillingChargeInvoice(action: ServerAction, req: Request, res: Response): Promise<void> {
    // TODO - no use-case for this endpoint so far! - only used for troubleshooting!
    throw new Error('Method not implemented.');
    // // Check if component is active
    // UtilsService.assertComponentIsActiveFromToken(req.user, TenantComponents.BILLING,
    //   Action.BILLING_CHARGE_INVOICE, Entity.INVOICE, MODULE_NAME, 'handleBillingChargeInvoice');
    // // Filter
    // const filteredRequest = BillingSecurity.filterChargeInvoiceRequest(req.body);
    // // Get the Invoice
    // const invoice = await BillingStorage.getInvoice(req.user.tenantID, filteredRequest.ID); // ID of the Billing Invoice (not the stripe invoice)
    // UtilsService.assertObjectExists(action, invoice, `Invoice ID '${filteredRequest.ID}' does not exist`,
    //   MODULE_NAME, 'handleDownloadInvoice', req.user);
    // // Check Auth
    // // if (!await Authorizations.canChargeInvoice(req.user, invoice.userID)) {
    // //   throw new AppAuthError({
    // //     errorCode: HTTPAuthError.ERROR,
    // //     user: req.user,
    // //     entity: Entity.INVOICE, action: Action.CHARGE_INVOICE,
    // //     module: MODULE_NAME, method: 'handleBillingChargeInvoice',
    // //   });
    // // }
    // // Get the billing impl
    // const billingImpl = await BillingFactory.getBillingImpl(req.user.tenantID);
    // if (!billingImpl) {
    //   throw new AppError({
    //     source: Constants.CENTRAL_SERVER,
    //     errorCode: HTTPError.GENERAL_ERROR,
    //     message: 'Billing service is not configured',
    //     module: MODULE_NAME, method: 'handleBillingChargeInvoice',
    //     action: action,
    //     user: req.user
    //   });
    // }
    // // Invoke the billing implementation (stripe)
    // let billingInvoice:BillingInvoice = await billingImpl.getInvoice(invoice.invoiceID);
    // billingInvoice = await billingImpl.chargeInvoice(billingInvoice);
    // res.json({
    //   succeeded: true,
    //   status: billingInvoice.status
    // });
  }

  public static async handleBillingWebHook(action: ServerAction, req: Request, res: Response, next: NextFunction): Promise<void> {
    // Check if component is active
    UtilsService.assertComponentIsActiveFromToken(req.user, TenantComponents.BILLING,
      Action.SYNCHRONIZE, Entity.BILLING, MODULE_NAME, 'handleBillingWebHook');
    // Check if component is active
    // ?? How to do it in this context
    // Filter
    const filteredRequest = BillingSecurity.filterBillingWebHookRequest(req.query);
    // Check Auth
    // How to check it - no JWT!
    // Retrieve Tenant ID from the URL Query Parameters
    if (!filteredRequest.tenantID) {

      throw new AppError({
        source: Constants.CENTRAL_SERVER,
        errorCode: HTTPError.GENERAL_ERROR,
        message: 'Unexpected situation - TenantID is not set',
        module: MODULE_NAME, method: 'handleBillingWebHook',
        action: action,
        // User: req.user
      });
    }
    const billingImpl = await BillingFactory.getBillingImpl(filteredRequest.tenantID);
    if (!billingImpl) {
      throw new AppError({
        source: Constants.CENTRAL_SERVER,
        errorCode: HTTPError.GENERAL_ERROR,
        message: 'Billing service is not configured',
        module: MODULE_NAME, method: 'handleBillingWebHook',
        action: action,
        // User: req.user
      });
    }
    // STRIPE expects a fast response - make sure to postpone time consuming operations when handling these events
    const done = await billingImpl.consumeBillingEvent(req);
    // Return a response to acknowledge receipt of the event
    res.json({ received: done });
    next();
  }

  public static async handleGetBillingSetting(action: ServerAction, req: Request, res: Response, next: NextFunction): Promise<void> {
    // Check if component is active
    UtilsService.assertComponentIsActiveFromToken(req.user, TenantComponents.BILLING,
      Action.READ, Entity.SETTING, MODULE_NAME, 'handleGetBillingSetting');
    // Check auth
    if (!await Authorizations.canReadBillingSetting(req.user)) {
      throw new AppAuthError({
        errorCode: HTTPAuthError.FORBIDDEN,
        user: req.user,
        action: Action.READ, entity: Entity.SETTING,
        module: MODULE_NAME, method: 'handleGetBillingSetting',
      });
    }
    const billingSettings: BillingSettings = await SettingStorage.getBillingSetting(req.user.tenantID);
    UtilsService.assertObjectExists(action, billingSettings, 'Failed to load billing settings', MODULE_NAME, 'handleGetBillingSetting', req.user);
    UtilsService.hashSensitiveData(req.user.tenantID, billingSettings);
    // Ok
    res.json(billingSettings);
    next();
  }

  public static async handleUpdateBillingSetting(action: ServerAction, req: Request, res: Response, next: NextFunction): Promise<void> {
    // Check if component is active
    UtilsService.assertComponentIsActiveFromToken(req.user, TenantComponents.BILLING,
      Action.UPDATE, Entity.SETTING, MODULE_NAME, 'handleUpdateBillingSetting');
    // Check auth
    if (!await Authorizations.canUpdateBillingSetting(req.user)) {
      throw new AppAuthError({
        errorCode: HTTPAuthError.FORBIDDEN,
        user: req.user,
        action: Action.UPDATE, entity: Entity.SETTING,
        module: MODULE_NAME, method: 'handleUpdateBillingSetting',
      });
    }
    // Check
    const newBillingProperties = BillingValidator.getInstance().validateUpdateBillingSetting({ ...req.params, ...req.body });
    // Load previous settings
    const billingSettings = await SettingStorage.getBillingSetting(req.user.tenantID);
    UtilsService.assertObjectExists(action, billingSettings, 'Failed to load billing settings', MODULE_NAME, 'handleUpdateBillingSetting', req.user);
    await UtilsService.processSensitiveData(req.user.tenantID, billingSettings, newBillingProperties);
    // Billing properties to preserve
    const { usersLastSynchronizedOn } = billingSettings.billing;
    const previousTransactionBillingState = !!billingSettings.billing.isTransactionBillingActivated;
    // Billing properties to override
    const { immediateBillingAllowed, periodicBillingAllowed, taxID } = newBillingProperties.billing;
    const newTransactionBillingState = !!newBillingProperties.billing.isTransactionBillingActivated;
    if (!newTransactionBillingState && previousTransactionBillingState) {
      // Attempt to switch it OFF
      throw new AppError({
        source: Constants.CENTRAL_SERVER,
        errorCode: StatusCodes.METHOD_NOT_ALLOWED,
        message: 'Switching OFF the billing of transactions is forbidden',
        module: MODULE_NAME,
        method: 'handleUpdateBillingSetting'
      });
    }
    // -----------------------------------------------------------
    // ACHTUNG - Handle with care the activation of the billing
    // -----------------------------------------------------------
    let postponeTransactionBillingActivation = false;
    let isTransactionBillingActivated: boolean;
    if (newTransactionBillingState && !previousTransactionBillingState) {
      // --------------------------------------------------------------------------
      // Attempt to switch it ON
      // - We need to postpone the activation in order to check the prerequisites
      // - Prerequisites cannot be checked without first saving all other settings
      // ---------------------------------------------------------------------------
      isTransactionBillingActivated = false ;
      postponeTransactionBillingActivation = true;
    } else {
      // Let's preserve the previous state
      isTransactionBillingActivated = previousTransactionBillingState;
    }
    // Now populates the settings with the new values
    billingSettings.billing = {
      isTransactionBillingActivated,
      usersLastSynchronizedOn,
      immediateBillingAllowed,
      periodicBillingAllowed,
      taxID,
    };
    // Make sure to preserve critical connection properties
    let readOnlyProperties = {};
    if (previousTransactionBillingState) {
      readOnlyProperties = {
        // STRIPE keys cannot be changed when Billing was already in a PRODUCTIVE mode
        publicKey: billingSettings.stripe.publicKey,
        secretKey: billingSettings.stripe.secretKey,
      };
    }
    billingSettings.stripe = {
      ...newBillingProperties.stripe,
      ...readOnlyProperties
    };
    // Update timestamp
    billingSettings.lastChangedBy = { 'id': req.user.id };
    billingSettings.lastChangedOn = new Date();
    // Let's save the new settings
    await SettingStorage.saveBillingSetting(req.user.tenantID, billingSettings);
    // Post-process the activation of the billing feature
    if (postponeTransactionBillingActivation) {
      // Check
      await BillingService.checkActivationPrerequisites(action, req);
      // Well - everything was Ok, activation is possible
      billingSettings.billing.isTransactionBillingActivated = true;
      // Save it again now that we are sure
      await SettingStorage.saveBillingSetting(req.user.tenantID, billingSettings);
    }
    // Ok
    res.json(Constants.REST_RESPONSE_SUCCESS);
    next();
  }

  private static async checkActivationPrerequisites(action: ServerAction, req: Request) : Promise<void> {
    const billingImpl = await BillingFactory.getBillingImpl(req.user.tenantID);
    if (!billingImpl) {
      throw new AppError({
        source: Constants.CENTRAL_SERVER,
        errorCode: HTTPError.GENERAL_ERROR,
        message: 'Billing service is not configured',
        module: MODULE_NAME, method: 'checkActivationPrerequisites',
        action: action,
        user: req.user
      });
    }
    // Check the connection
    await billingImpl.checkConnection();
    // Let's validate the new settings before activating
    await billingImpl.checkActivationPrerequisites();
  }
}
