import { ExtractJwt, Strategy } from 'passport-jwt';
import { Handler, NextFunction, Request, RequestHandler, Response } from 'express';
import { HttpLoginRequest, HttpResetPasswordRequest } from '../../../../types/requests/HttpUserRequest';
import User, { UserRole, UserStatus } from '../../../../types/User';

import AppError from '../../../../exception/AppError';
import AuthValidator from '../validator/AuthValidator';
import Authorizations from '../../../../authorization/Authorizations';
import AxiosFactory from '../../../../utils/AxiosFactory';
import BillingFactory from '../../../../integration/billing/BillingFactory';
import Configuration from '../../../../utils/Configuration';
import Constants from '../../../../utils/Constants';
import { HTTPError } from '../../../../types/HTTPError';
import I18nManager from '../../../../utils/I18nManager';
import Logging from '../../../../utils/Logging';
import NotificationHandler from '../../../../notification/NotificationHandler';
import { ObjectID } from 'mongodb';
import { ServerAction } from '../../../../types/Server';
import SessionHashService from './SessionHashService';
import SettingStorage from '../../../../storage/mongodb/SettingStorage';
import SiteStorage from '../../../../storage/mongodb/SiteStorage';
import { StatusCodes } from 'http-status-codes';
import Tag from '../../../../types/Tag';
import TagStorage from '../../../../storage/mongodb/TagStorage';
import TenantStorage from '../../../../storage/mongodb/TenantStorage';
import UserStorage from '../../../../storage/mongodb/UserStorage';
import Utils from '../../../../utils/Utils';
import UtilsService from './UtilsService';
import jwt from 'jsonwebtoken';
import moment from 'moment';
import passport from 'passport';

const _centralSystemRestConfig = Configuration.getCentralSystemRestServiceConfig();
let jwtOptions;

// Init JWT auth options
if (_centralSystemRestConfig) {
  // Set
  jwtOptions = {
    jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
    secretOrKey: _centralSystemRestConfig.userTokenKey
  };
  // Use
  passport.use(new Strategy(jwtOptions, (jwtPayload, done) =>
    // Return the token decoded right away
    done(null, jwtPayload)
  ));
}

const MODULE_NAME = 'AuthService';

export default class AuthService {
  public static initialize(): Handler {
    return passport.initialize();
  }

  public static authenticate(): RequestHandler {
    return passport.authenticate('jwt', { session: false });
  }

  public static async checkSessionHash(req: Request, res: Response, next: NextFunction): Promise<void> {
    // Check if User has been updated and require new login
    if (!await SessionHashService.isSessionHashUpdated(req, res, next)) {
      next();
    }
  }

  public static async handleLogIn(action: ServerAction, req: Request, res: Response, next: NextFunction): Promise<void> {
    // Filter
    const filteredRequest = AuthValidator.getInstance().validateAuthSignIn(req.body);
    // Get Tenant
    const tenantID = await AuthService.getTenantID(filteredRequest.tenant);
    if (!tenantID) {
      throw new AppError({
        source: Constants.CENTRAL_SERVER,
        errorCode: HTTPError.OBJECT_DOES_NOT_EXIST_ERROR,
        message: `User with Email '${filteredRequest.email}' tried to log in with an unknown tenant '${filteredRequest.tenant}'!`,
        module: MODULE_NAME,
        method: 'handleLogIn',
        action: action
      });
    }
    req.user = { tenantID };
    const user = await UserStorage.getUserByEmail(tenantID, filteredRequest.email);
    UtilsService.assertObjectExists(action, user, `User with email '${filteredRequest.email}' does not exist`,
      MODULE_NAME, 'handleLogIn', req.user);
    // Check if the number of trials is reached
    if (user.passwordWrongNbrTrials >= _centralSystemRestConfig.passwordWrongNumberOfTrial) {
      // Check if the user is still locked
      if (user.status === UserStatus.LOCKED) {
        // Yes: Check date to reset pass
        if (user.passwordBlockedUntil && moment(user.passwordBlockedUntil).isBefore(moment())) {
          // Time elapsed: activate the account again
          await Logging.logSecurityInfo({
            tenantID: req.user.tenantID,
            actionOnUser: user,
            module: MODULE_NAME, method: 'handleLogIn', action: action,
            message: 'User has been unlocked after a period of time can try to login again'
          });
          // Save User Status
          await UserStorage.saveUserStatus(req.user.tenantID, user.id, UserStatus.ACTIVE);
          // Init User Password
          await UserStorage.saveUserPassword(req.user.tenantID, user.id,
            { passwordWrongNbrTrials: 0, passwordBlockedUntil: null, passwordResetHash: null });
          // Read user again
          const updatedUser = await UserStorage.getUser(tenantID, user.id);
          // Check user
          await AuthService.checkUserLogin(action, tenantID, updatedUser, filteredRequest, req, res, next);
        } else {
          // Return data
          throw new AppError({
            source: Constants.CENTRAL_SERVER,
            errorCode: HTTPError.USER_ACCOUNT_LOCKED_ERROR,
            message: 'User is locked',
            module: MODULE_NAME,
            method: 'handleLogIn'
          });
        }
      } else {
        // An admin has reactivated the account
        user.passwordWrongNbrTrials = 0;
        user.passwordBlockedUntil = null;
        // Check user
        await AuthService.checkUserLogin(action, tenantID, user, filteredRequest, req, res, next);
      }
    } else {
      // Nbr trials OK: Check user
      await AuthService.checkUserLogin(action, tenantID, user, filteredRequest, req, res, next);
    }
  }

  public static async handleRegisterUser(action: ServerAction, req: Request, res: Response, next: NextFunction): Promise<void> {
    // Filter
    const filteredRequest = AuthValidator.getInstance().validateAuthSignOn(req.body);
    // Override
    filteredRequest.status = UserStatus.PENDING;
    if (!filteredRequest.locale) {
      filteredRequest.locale = Constants.DEFAULT_LOCALE;
    }
    // Get the Tenant
    const tenantID = await AuthService.getTenantID(filteredRequest.tenant);
    if (!tenantID) {
      throw new AppError({
        source: Constants.CENTRAL_SERVER,
        errorCode: HTTPError.OBJECT_DOES_NOT_EXIST_ERROR,
        message: `User is trying to register with an unknown tenant '${filteredRequest.tenant}'!`,
        module: MODULE_NAME,
        method: 'handleRegisterUser'
      });
    }
    req.user = { tenantID };
    // Check Captcha
    const recaptchaURL = `https://www.google.com/recaptcha/api/siteverify?secret=${_centralSystemRestConfig.captchaSecretKey}&response=${filteredRequest.captcha}&remoteip=${req.connection.remoteAddress}`;
    const response = await AxiosFactory.getAxiosInstance(tenantID).get(recaptchaURL);
    if (!response.data.success) {
      throw new AppError({
        source: Constants.CENTRAL_SERVER,
        errorCode: HTTPError.GENERAL_ERROR,
        message: 'The captcha is invalid',
        module: MODULE_NAME,
        method: 'handleRegisterUser'
      });
    } else if (response.data.score < 0.5) {
      throw new AppError({
        source: Constants.CENTRAL_SERVER,
        errorCode: HTTPError.GENERAL_ERROR,
        message: 'The captcha score is too low',
        module: MODULE_NAME,
        method: 'handleRegisterUser'
      });
    }
    // Check Mandatory field
    Object.assign(filteredRequest, { password: filteredRequest.passwords.password });
    UtilsService.checkIfUserValid(filteredRequest as User, null, req);
    // Check email
    const user = await UserStorage.getUserByEmail(tenantID, filteredRequest.email);
    if (user) {
      throw new AppError({
        source: Constants.CENTRAL_SERVER,
        errorCode: HTTPError.USER_EMAIL_ALREADY_EXIST_ERROR,
        message: 'Email already exists',
        module: MODULE_NAME,
        method: 'handleRegisterUser'
      });
    }
    // Generate a password
    const newPasswordHashed = await Utils.hashPasswordBcrypt(filteredRequest.passwords.password);
    // Create the user
    const newUser = UserStorage.createNewUser() as User;
    newUser.email = filteredRequest.email;
    newUser.name = filteredRequest.name;
    newUser.firstName = filteredRequest.firstName;
    newUser.locale = filteredRequest.locale;
    newUser.createdOn = new Date();
    const verificationToken = Utils.generateToken(filteredRequest.email);
    const endUserLicenseAgreement = await UserStorage.getEndUserLicenseAgreement(tenantID, Utils.getLanguageFromLocale(newUser.locale));
    // Save User
    newUser.id = await UserStorage.saveUser(tenantID, newUser);
    // Save User Status
    if (tenantID === Constants.DEFAULT_TENANT) {
      await UserStorage.saveUserRole(tenantID, newUser.id, UserRole.SUPER_ADMIN);
    } else {
      await UserStorage.saveUserRole(tenantID, newUser.id, UserRole.BASIC);
    }
    // Save User Status
    await UserStorage.saveUserStatus(tenantID, newUser.id, UserStatus.PENDING);
    // Get the i18n translation class
    const i18nManager = I18nManager.getInstanceForLocale(newUser.locale);
    const tag: Tag = {
      id: newUser.name[0] + newUser.firstName[0] + Utils.getRandomIntSafe().toString(),
      visualID: new ObjectID().toString(),
      active: true,
      issuer: true,
      userID: newUser.id,
      createdBy: { id: newUser.id },
      createdOn: new Date(),
      description: i18nManager.translate('tags.virtualBadge'),
      default: true
    };
    await TagStorage.saveTag(req.user.tenantID, tag);
    // Save User password
    await UserStorage.saveUserPassword(tenantID, newUser.id,
      {
        password: newPasswordHashed,
        passwordWrongNbrTrials: 0,
        passwordResetHash: null,
        passwordBlockedUntil: null
      });
    // Save User Account Verification
    await UserStorage.saveUserAccountVerification(tenantID, newUser.id, { verificationToken });
    // Save User EULA
    await UserStorage.saveUserEULA(tenantID, newUser.id,
      {
        eulaAcceptedOn: new Date(),
        eulaAcceptedVersion: endUserLicenseAgreement.version,
        eulaAcceptedHash: endUserLicenseAgreement.hash
      });
    // Assign user to all sites with auto-assign flag set
    const sites = await SiteStorage.getSites(tenantID,
      { withAutoUserAssignment: true },
      Constants.DB_PARAMS_MAX_LIMIT
    );
    if (sites.count > 0) {
      const siteIDs = sites.result.map((site) => site.id);
      if (siteIDs && siteIDs.length > 0) {
        await UserStorage.addSitesToUser(tenantID, newUser.id, siteIDs);
      }
    }
    // Log
    await Logging.logSecurityInfo({
      tenantID: tenantID,
      user: newUser, action: action,
      module: MODULE_NAME,
      method: 'handleRegisterUser',
      message: `User with Email '${req.body.email}' has been created successfully`,
      detailedMessages: { params: req.body }
    });
    if (tenantID !== Constants.DEFAULT_TENANT) {
      // Send notification
      const evseDashboardVerifyEmailURL = Utils.buildEvseURL(filteredRequest.tenant) +
        '/verify-email?VerificationToken=' + verificationToken + '&Email=' + newUser.email;
      // Notify (Async)
      NotificationHandler.sendNewRegisteredUser(
        tenantID,
        Utils.generateUUID(),
        newUser,
        {
          'tenant': filteredRequest.name,
          'user': newUser,
          'evseDashboardURL': Utils.buildEvseURL(filteredRequest.tenant),
          'evseDashboardVerifyEmailURL': evseDashboardVerifyEmailURL
        }
      ).catch(() => { });
    }
    // Ok
    res.json(Constants.REST_RESPONSE_SUCCESS);
    next();
  }

  public static async checkAndSendResetPasswordConfirmationEmail(tenantID: string, filteredRequest: Partial<HttpResetPasswordRequest>, action: ServerAction, req: Request,
      res: Response, next: NextFunction): Promise<void> {
    // No hash: Send email with init pass hash link
    if (!filteredRequest.captcha) {
      throw new AppError({
        source: Constants.CENTRAL_SERVER,
        errorCode: HTTPError.GENERAL_ERROR,
        message: 'The captcha is mandatory',
        module: MODULE_NAME,
        method: 'checkAndSendResetPasswordConfirmationEmail'
      });
    }
    // Check captcha
    const recaptchaURL = `https://www.google.com/recaptcha/api/siteverify?secret=${_centralSystemRestConfig.captchaSecretKey}&response=${filteredRequest.captcha}&remoteip=${req.connection.remoteAddress}`;
    const response = await AxiosFactory.getAxiosInstance(tenantID).get(recaptchaURL);
    // Check
    if (!response.data.success) {
      throw new AppError({
        source: Constants.CENTRAL_SERVER,
        errorCode: HTTPError.GENERAL_ERROR,
        message: 'The reCaptcha is invalid',
        module: MODULE_NAME,
        method: 'checkAndSendResetPasswordConfirmationEmail'
      });
    } else if (response.data.score < 0.5) {
      throw new AppError({
        source: Constants.CENTRAL_SERVER,
        errorCode: HTTPError.GENERAL_ERROR,
        message: `The reCaptcha score is too low, got ${response.data.score} and expected to be >= 0.5`,
        module: MODULE_NAME,
        method: 'checkAndSendResetPasswordConfirmationEmail'
      });
    }
    // Generate a new password
    const user = await UserStorage.getUserByEmail(tenantID, filteredRequest.email);
    UtilsService.assertObjectExists(action, user, `User with email '${filteredRequest.email}' does not exist`,
      MODULE_NAME, 'checkAndSendResetPasswordConfirmationEmail', req.user);
    const resetHash = Utils.generateUUID();
    // Init Password info
    await UserStorage.saveUserPassword(tenantID, user.id, { passwordResetHash: resetHash });
    // Log
    await Logging.logSecurityInfo({
      tenantID: tenantID,
      user: user, action: action,
      module: MODULE_NAME,
      method: 'checkAndSendResetPasswordConfirmationEmail',
      message: `User with Email '${req.body.email}' will receive an email to reset his password`
    });
    // Send notification
    const evseDashboardResetPassURL = Utils.buildEvseURL(filteredRequest.tenant) +
      '/define-password?hash=' + resetHash;
    // Send Request Password (Async)
    NotificationHandler.sendRequestPassword(
      tenantID,
      Utils.generateUUID(),
      user,
      {
        'user': user,
        'evseDashboardURL': Utils.buildEvseURL(filteredRequest.tenant),
        'evseDashboardResetPassURL': evseDashboardResetPassURL
      }
    ).catch(() => { });
    // Ok
    res.json(Constants.REST_RESPONSE_SUCCESS);
    next();
  }

  public static async resetUserPassword(tenantID: string, filteredRequest: Partial<HttpResetPasswordRequest>, action: ServerAction, req: Request, res: Response, next: NextFunction): Promise<void> {
    // Get the user
    const user = await UserStorage.getUserByPasswordResetHash(tenantID, filteredRequest.hash);
    UtilsService.assertObjectExists(action, user, `User with password reset hash '${filteredRequest.hash}' does not exist`,
      MODULE_NAME, 'handleUserPasswordReset', req.user);
    // Check password
    if (!Utils.isPasswordValid(filteredRequest.passwords.password)) {
      throw new AppError({
        source: Constants.CENTRAL_SERVER,
        errorCode: HTTPError.OBJECT_DOES_NOT_EXIST_ERROR,
        message: `Password with reset hash '${filteredRequest.hash}' is not strong enough`,
        module: MODULE_NAME,
        user: user,
        method: 'handleUserPasswordReset'
      });
    }
    // Hash it
    const newHashedPassword = await Utils.hashPasswordBcrypt(filteredRequest.passwords.password);
    // Save new password
    await UserStorage.saveUserPassword(tenantID, user.id,
      {
        password: newHashedPassword,
        passwordWrongNbrTrials: 0,
        passwordResetHash: null,
        passwordBlockedUntil: null
      }
    );
    // Unlock
    if (user.status === UserStatus.LOCKED) {
      await UserStorage.saveUserStatus(tenantID, user.id, UserStatus.ACTIVE);
    }
    // Log
    await Logging.logSecurityInfo({
      tenantID: tenantID,
      user: user, action: action,
      module: MODULE_NAME,
      method: 'handleUserPasswordReset',
      message: 'User\'s password has been reset successfully',
      detailedMessages: { params: req.body }
    });
    // Ok
    res.json(Constants.REST_RESPONSE_SUCCESS);
    next();
  }

  public static async handleUserPasswordReset(action: ServerAction, req: Request, res: Response, next: NextFunction): Promise<void> {
    const filteredRequest = AuthValidator.getInstance().validateAuthResetPassword(req.body);
    // Get Tenant
    const tenantID = await AuthService.getTenantID(filteredRequest.tenant);
    if (!tenantID) {
      throw new AppError({
        source: Constants.CENTRAL_SERVER,
        errorCode: HTTPError.OBJECT_DOES_NOT_EXIST_ERROR,
        message: `User is trying to access resource with an unknown tenant '${filteredRequest.tenant}'!`,
        module: MODULE_NAME,
        method: 'handleUserPasswordReset',
        action: action
      });
    }
    // Check hash
    if (filteredRequest.hash) {
      // Send the new password
      await AuthService.resetUserPassword(tenantID, filteredRequest, action, req, res, next);
    } else {
      // Send Confirmation Email for requesting a new password
      await AuthService.checkAndSendResetPasswordConfirmationEmail(tenantID, filteredRequest, action, req, res, next);
    }
  }

  public static async handleCheckEndUserLicenseAgreement(action: ServerAction, req: Request, res: Response, next: NextFunction): Promise<void> {
    // Filter
    const filteredRequest = AuthValidator.getInstance().validateAuthCheckEula(req.query);
    // Get Tenant
    const tenantID = await AuthService.getTenantID(filteredRequest.Tenant);
    if (!tenantID) {
      throw new AppError({
        source: Constants.CENTRAL_SERVER,
        errorCode: HTTPError.GENERAL_ERROR,
        message: 'The Tenant is mandatory',
        module: MODULE_NAME,
        method: 'handleCheckEndUserLicenseAgreement'
      });
    }
    // Get User
    const user = await UserStorage.getUserByEmail(tenantID, filteredRequest.Email);
    if (!user) {
      // Do not return error, only reject it
      res.json({ eulaAccepted: false });
      next();
      return;
    }
    // Get last Eula version
    const endUserLicenseAgreement = await UserStorage.getEndUserLicenseAgreement(tenantID, Utils.getLanguageFromLocale(user.locale));
    if (user.eulaAcceptedHash === endUserLicenseAgreement.hash) {
      // Check if version matches
      res.json({ eulaAccepted: true });
      next();
      return;
    }
    // Check if version matches
    res.json({ eulaAccepted: false });
    next();
  }

  public static async handleGetEndUserLicenseAgreement(action: ServerAction, req: Request, res: Response, next: NextFunction): Promise<void> {
    // Filter
    const filteredRequest = AuthValidator.getInstance().validateAuthEula(req.query);
    // Get it
    const endUserLicenseAgreement = await UserStorage.getEndUserLicenseAgreement(Constants.DEFAULT_TENANT, filteredRequest.Language);
    res.json(endUserLicenseAgreement);
    next();
  }

  public static async handleVerifyEmail(action: ServerAction, req: Request, res: Response, next: NextFunction): Promise<void> {
    // Filter
    const filteredRequest = AuthValidator.getInstance().validateAuthVerifyEmail(req.query);
    // Get Tenant
    const tenantID = await AuthService.getTenantID(filteredRequest.Tenant);
    if (!tenantID) {
      throw new AppError({
        source: Constants.CENTRAL_SERVER,
        errorCode: HTTPError.OBJECT_DOES_NOT_EXIST_ERROR,
        action: action,
        module: MODULE_NAME,
        method: 'handleVerifyEmail',
        message: `User is trying to access resource with an unknown tenant '${filteredRequest.Tenant}'!`
      });
    }
    // Check that this is not the super tenant
    if (tenantID === Constants.DEFAULT_TENANT) {
      throw new AppError({
        source: Constants.CENTRAL_SERVER,
        errorCode: HTTPError.GENERAL_ERROR,
        action: action,
        module: MODULE_NAME, method: 'handleVerifyEmail',
        message: 'Cannot verify email in the Super Tenant'
      });
    }
    // Check email
    const user = await UserStorage.getUserByEmail(tenantID, filteredRequest.Email);
    UtilsService.assertObjectExists(action, user, `User with email '${filteredRequest.Email}' does not exist`,
      MODULE_NAME, 'handleVerifyEmail', req.user);
    // Check if account is already active
    if (user.status === UserStatus.ACTIVE) {
      throw new AppError({
        source: Constants.CENTRAL_SERVER,
        errorCode: HTTPError.USER_ACCOUNT_ALREADY_ACTIVE_ERROR,
        action: action,
        user: user,
        module: MODULE_NAME, method: 'handleVerifyEmail',
        message: 'Account is already active'
      });
    }
    // Check verificationToken
    if (user.verificationToken !== filteredRequest.VerificationToken) {
      throw new AppError({
        source: Constants.CENTRAL_SERVER,
        errorCode: HTTPError.INVALID_TOKEN_ERROR,
        action: action,
        user: user,
        module: MODULE_NAME, method: 'handleVerifyEmail',
        message: 'Wrong Verification Token'
      });
    }
    const userSettings = await SettingStorage.getUserSettings(tenantID);
    const userStatus = userSettings.user.autoActivateAccountAfterValidation ? UserStatus.ACTIVE : UserStatus.INACTIVE;
    // Save User Status
    await UserStorage.saveUserStatus(tenantID, user.id, userStatus);
    // For integration with billing
    const billingImpl = await BillingFactory.getBillingImpl(tenantID);
    if (billingImpl) {
      try {
        await billingImpl.synchronizeUser(user);
        await Logging.logInfo({
          tenantID: tenantID,
          module: MODULE_NAME, method: 'handleVerifyEmail',
          action: action,
          user: user,
          message: 'User has been created successfully in the billing system'
        });
      } catch (error) {
        await Logging.logError({
          tenantID: tenantID,
          module: MODULE_NAME, method: 'handleVerifyEmail',
          action: action,
          user: user,
          message: 'User cannot be created in the billing system',
          detailedMessages: { error: error.message, stack: error.stack }
        });
      }
    }
    // Save User Verification Account
    await UserStorage.saveUserAccountVerification(tenantID, user.id,
      { verificationToken: null, verifiedAt: new Date() });
    // Log
    await Logging.logSecurityInfo({
      tenantID: tenantID,
      user: user, action: action,
      module: MODULE_NAME, method: 'handleVerifyEmail',
      message: userStatus === UserStatus.ACTIVE ?
        'User account has been successfully verified and activated' :
        'User account has been successfully verified but needs an admin to activate it',
      detailedMessages: { params: req.query }
    });
    NotificationHandler.sendAccountVerification(
      tenantID,
      Utils.generateUUID(),
      user,
      {
        'user': user,
        'userStatus': userStatus,
        'evseDashboardURL': Utils.buildEvseURL(filteredRequest.Tenant),
      }
    ).catch(() => { });
    // Ok
    res.json({ status: 'Success', userStatus });
    next();
  }

  public static async handleResendVerificationEmail(action: ServerAction, req: Request, res: Response, next: NextFunction): Promise<void> {
    const filteredRequest = AuthValidator.getInstance().validateAuthResendVerificationEmail(req.body);
    // Get the tenant
    const tenantID = await AuthService.getTenantID(filteredRequest.tenant);
    if (!tenantID) {
      throw new AppError({
        source: Constants.CENTRAL_SERVER,
        errorCode: HTTPError.OBJECT_DOES_NOT_EXIST_ERROR,
        message: `User is trying to access resource with an unknown tenant '${filteredRequest.tenant}'!`,
        module: MODULE_NAME,
        method: 'handleResendVerificationEmail',
        action: action
      });
    }
    // Check that this is not the super tenant
    if (tenantID === Constants.DEFAULT_TENANT) {
      throw new AppError({
        source: Constants.CENTRAL_SERVER,
        errorCode: HTTPError.GENERAL_ERROR,
        message: 'Cannot request a verification Email in the Super Tenant',
        module: MODULE_NAME,
        method: 'handleResendVerificationEmail',
        action: action
      });
    }

    // Is valid captcha?
    const recaptchaURL = `https://www.google.com/recaptcha/api/siteverify?secret=${_centralSystemRestConfig.captchaSecretKey}&response=${filteredRequest.captcha}&remoteip=${req.connection.remoteAddress}`;
    const response = await AxiosFactory.getAxiosInstance(tenantID).get(recaptchaURL);
    if (!response.data.success) {
      throw new AppError({
        source: Constants.CENTRAL_SERVER,
        errorCode: HTTPError.GENERAL_ERROR,
        message: 'The captcha is invalid',
        module: MODULE_NAME,
        method: 'handleResendVerificationEmail',
        action: action
      });
    } else if (response.data.score < 0.5) {
      throw new AppError({
        source: Constants.CENTRAL_SERVER,
        errorCode: HTTPError.GENERAL_ERROR,
        message: 'The captcha is too low',
        module: MODULE_NAME,
        method: 'handleResendVerificationEmail',
        action: action
      });
    }
    // Is valid email?
    const user = await UserStorage.getUserByEmail(tenantID, filteredRequest.email);
    UtilsService.assertObjectExists(action, user, `User with email '${filteredRequest.email}' does not exist`,
      MODULE_NAME, 'handleResendVerificationEmail', req.user);
    // Check if account is already active
    if (user.status === UserStatus.ACTIVE) {
      throw new AppError({
        source: Constants.CENTRAL_SERVER,
        errorCode: HTTPError.USER_ACCOUNT_ALREADY_ACTIVE_ERROR,
        message: 'Account is already active',
        module: MODULE_NAME,
        method: 'handleResendVerificationEmail',
        action: action,
        user: user
      });
    }
    let verificationToken: string;
    // Check verificationToken
    if (!user.verificationToken) {
      // Verification token was not created after registration
      // This should not happen
      // Generate new verificationToken
      verificationToken = Utils.generateToken(filteredRequest.email);
      user.verificationToken = verificationToken;
      // Save User Verification Account
      await UserStorage.saveUserAccountVerification(tenantID, user.id, { verificationToken });
    } else {
      // Get existing verificationToken
      verificationToken = user.verificationToken;
    }
    // Log
    await Logging.logSecurityInfo({
      tenantID: tenantID,
      user: user,
      action: action,
      module: MODULE_NAME,
      method: 'handleResendVerificationEmail',
      message: `User with Email '${filteredRequest.email}' has been created successfully`,
      detailedMessages: { params: req.body }
    });
    // Send notification
    const evseDashboardVerifyEmailURL = Utils.buildEvseURL(filteredRequest.tenant) +
      '/verify-email?VerificationToken=' + verificationToken + '&Email=' +
      user.email;
    // Send Verification Email (Async)
    NotificationHandler.sendVerificationEmail(
      tenantID,
      Utils.generateUUID(),
      user,
      {
        'user': user,
        'evseDashboardURL': Utils.buildEvseURL(filteredRequest.tenant),
        'evseDashboardVerifyEmailURL': evseDashboardVerifyEmailURL
      }
    ).catch(() => { });
    // Ok
    res.json(Constants.REST_RESPONSE_SUCCESS);
    next();
  }

  public static handleUserLogOut(action: ServerAction, req: Request, res: Response, next: NextFunction): void {
    req.logout();
    res.status(StatusCodes.OK).send({});
  }

  public static async userLoginWrongPassword(action: ServerAction, tenantID: string, user: User, req: Request, res: Response, next: NextFunction): Promise<void> {
    // Add wrong trial + 1
    if (isNaN(user.passwordWrongNbrTrials)) {
      user.passwordWrongNbrTrials = 0;
    }
    const passwordWrongNbrTrials = user.passwordWrongNbrTrials + 1;
    // Check if the number of trial is reached
    if (passwordWrongNbrTrials >= _centralSystemRestConfig.passwordWrongNumberOfTrial) {
      // Too many attempts, lock user
      // Save User Status
      await UserStorage.saveUserStatus(tenantID, user.id, UserStatus.LOCKED);
      // Save User Blocked Date
      await UserStorage.saveUserPassword(tenantID, user.id,
        {
          passwordWrongNbrTrials,
          passwordBlockedUntil: moment().add(_centralSystemRestConfig.passwordBlockedWaitTimeMin, 'm').toDate()
        });
      // Log
      throw new AppError({
        source: Constants.CENTRAL_SERVER,
        errorCode: HTTPError.USER_ACCOUNT_LOCKED_ERROR,
        message: 'User is locked',
        module: MODULE_NAME,
        method: 'checkUserLogin',
        action: action,
        user: user
      });
    } else {
      // Save User Nbr Password Trials
      await UserStorage.saveUserPassword(tenantID, user.id, { passwordWrongNbrTrials });
      // Log
      throw new AppError({
        source: Constants.CENTRAL_SERVER,
        errorCode: HTTPError.OBJECT_DOES_NOT_EXIST_ERROR,
        message: `User failed to log in, ${_centralSystemRestConfig.passwordWrongNumberOfTrial - user.passwordWrongNbrTrials} trial(s) remaining`,
        module: MODULE_NAME,
        method: 'checkUserLogin',
        action: action,
        user: user
      });
    }
  }

  public static async userLoginSucceeded(action: ServerAction, tenantID: string, user: User, req: Request, res: Response, next: NextFunction): Promise<void> {
    // Password / Login OK
    await Logging.logSecurityInfo({
      tenantID: tenantID,
      user: user,
      module: MODULE_NAME, method: 'checkUserLogin',
      action: action, message: 'User logged in successfully'
    });
    // Set Eula Info on Login Only
    if (action === ServerAction.LOGIN) {
      // Save EULA
      const endUserLicenseAgreement = await UserStorage.getEndUserLicenseAgreement(tenantID, Utils.getLanguageFromLocale(user.locale));
      await UserStorage.saveUserEULA(tenantID, user.id,
        {
          eulaAcceptedOn: new Date(),
          eulaAcceptedVersion: endUserLicenseAgreement.version,
          eulaAcceptedHash: endUserLicenseAgreement.hash
        }
      );
    }
    // Reset wrong number of trial
    await UserStorage.saveUserPassword(tenantID, user.id,
      { passwordWrongNbrTrials: 0, passwordBlockedUntil: null, passwordResetHash: null });
    // Get the tags (limited) to avoid an overweighted token
    const tags = await TagStorage.getTags(tenantID, { userIDs: [user.id] }, Constants.DB_PARAMS_DEFAULT_RECORD);
    // Yes: build token
    const payload = await Authorizations.buildUserToken(tenantID, user, tags.result);
    // Build token
    let token: string;
    // Role Demo?
    if (Authorizations.isDemo(user)) {
      token = jwt.sign(payload, jwtOptions.secretOrKey, {
        expiresIn: _centralSystemRestConfig.userDemoTokenLifetimeDays * 24 * 3600
      });
    } else {
      token = jwt.sign(payload, jwtOptions.secretOrKey, {
        expiresIn: _centralSystemRestConfig.userTokenLifetimeHours * 3600
      });
    }
    // Return it
    res.json({ token: token });
  }

  public static async getTenantID(subdomain: string): Promise<string> {
    // Check
    if (!subdomain) {
      return Constants.DEFAULT_TENANT;
    }
    // Get it
    const tenant = await TenantStorage.getTenantBySubdomain(subdomain);
    // Return
    return (tenant ? tenant.id : null);
  }

  public static async checkUserLogin(action: ServerAction, tenantID: string, user: User,
      filteredRequest: Partial<HttpLoginRequest>, req: Request, res: Response, next: NextFunction): Promise<void> {
    // User Found?
    if (!user) {
      throw new AppError({
        source: Constants.CENTRAL_SERVER,
        errorCode: HTTPError.OBJECT_DOES_NOT_EXIST_ERROR,
        message: `Unknown user tried to log in with email '${filteredRequest.email}'`,
        module: MODULE_NAME,
        method: 'checkUserLogin',
        user: user
      });
    }
    // Check password
    let match = false;
    if (user.password) {
      match = await Utils.checkPasswordBCrypt(filteredRequest.password, user.password);
    }
    // Check password hash
    if (match || (user.password === Utils.hashPassword(filteredRequest.password))) {
      // Check status
      switch (user.status) {
        case UserStatus.PENDING:
          throw new AppError({
            source: Constants.CENTRAL_SERVER,
            errorCode: HTTPError.USER_ACCOUNT_PENDING_ERROR,
            message: 'Account is pending! User must activate his account in his email',
            module: MODULE_NAME,
            method: 'checkUserLogin',
            user: user
          });
        case UserStatus.LOCKED:
          throw new AppError({
            source: Constants.CENTRAL_SERVER,
            errorCode: HTTPError.USER_ACCOUNT_LOCKED_ERROR,
            message: `Account is locked ('${user.status}')`,
            module: MODULE_NAME,
            method: 'checkUserLogin',
            user: user
          });
        case UserStatus.INACTIVE:
          throw new AppError({
            source: Constants.CENTRAL_SERVER,
            errorCode: HTTPError.USER_ACCOUNT_INACTIVE_ERROR,
            message: `Account is inactive ('${user.status}')`,
            module: MODULE_NAME,
            method: 'checkUserLogin',
            user: user
          });
        case UserStatus.BLOCKED:
          throw new AppError({
            source: Constants.CENTRAL_SERVER,
            errorCode: HTTPError.USER_ACCOUNT_BLOCKED_ERROR,
            message: `Account is blocked ('${user.status}')`,
            module: MODULE_NAME,
            method: 'checkUserLogin',
            user: user
          });
      }
      // Login OK
      await AuthService.userLoginSucceeded(action, tenantID, user, req, res, next);
    } else {
      // Login KO
      await AuthService.userLoginWrongPassword(action, tenantID, user, req, res, next);
    }
  }
}

