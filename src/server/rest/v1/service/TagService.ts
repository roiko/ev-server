import { Action, Entity } from '../../../../types/Authorization';
import { ActionsResponse, ImportStatus } from '../../../../types/GlobalType';
import { AsyncTaskType, AsyncTasks } from '../../../../types/AsyncTask';
import { DataResult, TagDataResult } from '../../../../types/DataResult';
import { HTTPAuthError, HTTPError } from '../../../../types/HTTPError';
import { NextFunction, Request, Response } from 'express';
import Tag, { ImportedTag, TagRequiredImportProperties } from '../../../../types/Tag';

import AppAuthError from '../../../../exception/AppAuthError';
import AppError from '../../../../exception/AppError';
import AsyncTaskManager from '../../../../async-task/AsyncTaskManager';
import AuthorizationService from './AuthorizationService';
import Authorizations from '../../../../authorization/Authorizations';
import Busboy from 'busboy';
import CSVError from 'csvtojson/v2/CSVError';
import Constants from '../../../../utils/Constants';
import EmspOCPIClient from '../../../../client/ocpi/EmspOCPIClient';
import { ImportedUser } from '../../../../types/User';
import JSONStream from 'JSONStream';
import LockingHelper from '../../../../locking/LockingHelper';
import LockingManager from '../../../../locking/LockingManager';
import Logging from '../../../../utils/Logging';
import OCPIClientFactory from '../../../../client/ocpi/OCPIClientFactory';
import { OCPIRole } from '../../../../types/ocpi/OCPIRole';
import { OCPITokenWhitelist } from '../../../../types/ocpi/OCPIToken';
import OCPIUtils from '../../../ocpi/OCPIUtils';
import { ServerAction } from '../../../../types/Server';
import { StatusCodes } from 'http-status-codes';
import TagSecurity from './security/TagSecurity';
import TagStorage from '../../../../storage/mongodb/TagStorage';
import TagValidator from '../validator/TagValidator';
import Tenant from '../../../../types/Tenant';
import TenantComponents from '../../../../types/TenantComponents';
import TenantStorage from '../../../../storage/mongodb/TenantStorage';
import TransactionStorage from '../../../../storage/mongodb/TransactionStorage';
import UserStorage from '../../../../storage/mongodb/UserStorage';
import UserToken from '../../../../types/UserToken';
import UserValidator from '../validator/UserValidator';
import Utils from '../../../../utils/Utils';
import UtilsService from './UtilsService';
import csvToJson from 'csvtojson/v2';

const MODULE_NAME = 'TagService';

export default class TagService {

  public static async handleGetTag(action: ServerAction, req: Request, res: Response, next: NextFunction): Promise<void> {
    // Filter request
    const filteredRequest = TagSecurity.filterTagRequestByID(req.query);
    // Check and Get Tag
    const tag = await UtilsService.checkAndGetTagAuthorization(req.tenant, req.user, filteredRequest.ID, Action.READ, action,
      { withUser: true }, true);
    // Return
    res.json(tag);
    next();
  }

  public static async handleGetTags(action: ServerAction, req: Request, res: Response, next: NextFunction): Promise<void> {
    // Return
    res.json(await TagService.getTags(req));
    next();
  }

  public static async handleDeleteTags(action: ServerAction, req: Request, res: Response, next: NextFunction): Promise<void> {
    // Filter
    const tagsIDs = TagSecurity.filterTagRequestByIDs(req.body);
    // Delete
    const result = await TagService.deleteTags(req.tenant, action, req.user, tagsIDs);
    // Return
    res.json({ ...result, ...Constants.REST_RESPONSE_SUCCESS });
    next();
  }

  public static async handleDeleteTag(action: ServerAction, req: Request, res: Response, next: NextFunction): Promise<void> {
    // Filter
    const filteredRequest = TagSecurity.filterTagRequestByID(req.query);
    // Delete
    await TagService.deleteTags(req.tenant, action, req.user, [filteredRequest.ID]);
    // Return
    res.json(Constants.REST_RESPONSE_SUCCESS);
    next();
  }

  public static async handleCreateTag(action: ServerAction, req: Request, res: Response, next: NextFunction): Promise<void> {
    // Filter
    const filteredRequest = TagSecurity.filterTagCreateRequest(req.body, req.user);
    // Check
    UtilsService.checkIfUserTagIsValid(filteredRequest, req);
    // Get dynamic auth
    const authorizationFilter = await AuthorizationService.checkAndGetTagAuthorizationFilters(req.tenant, req.user,
      filteredRequest, Action.CREATE);
    if (!authorizationFilter.authorized) {
      throw new AppAuthError({
        errorCode: HTTPAuthError.FORBIDDEN,
        user: req.user,
        action: Action.CREATE, entity: Entity.TAG,
        module: MODULE_NAME, method: 'handleCreateTag'
      });
    }
    // Check Tag
    let tag = await TagStorage.getTag(req.user.tenantID, filteredRequest.id.toUpperCase());
    if (tag) {
      throw new AppError({
        source: Constants.CENTRAL_SERVER,
        errorCode: HTTPError.TAG_ALREADY_EXIST_ERROR,
        message: `Tag with ID '${filteredRequest.id}' already exists`,
        module: MODULE_NAME, method: 'handleCreateTag',
        user: req.user,
        action: action
      });
    }
    // Check Tag
    tag = await TagStorage.getTagByVisualID(req.user.tenantID, filteredRequest.visualID);
    if (tag) {
      throw new AppError({
        source: Constants.CENTRAL_SERVER,
        errorCode: HTTPError.TAG_VISUAL_ID_ALREADY_EXIST_ERROR,
        message: `Tag with visual ID '${filteredRequest.id}' already exists`,
        module: MODULE_NAME, method: 'handleCreateTag',
        user: req.user,
        action: action
      });
    }
    const transactions = await TransactionStorage.getTransactions(req.user.tenantID,
      { tagIDs: [filteredRequest.id.toUpperCase()], hasUserID: true }, Constants.DB_PARAMS_SINGLE_RECORD);
    if (!Utils.isEmptyArray(transactions.result)) {
      throw new AppError({
        source: Constants.CENTRAL_SERVER,
        errorCode: HTTPError.TAG_HAS_TRANSACTIONS,
        message: `Tag with ID '${filteredRequest.id}' has been used in previous transactions`,
        module: MODULE_NAME, method: 'handleCreateTag',
        user: req.user,
        action: action
      });
    }
    // Get User authorization filters
    const authorizationUserFilters = await AuthorizationService.checkAndGetUserAuthorizationFilters(
      req.tenant, req.user, { ID: filteredRequest.userID });
    // Get the user
    const user = await UserStorage.getUser(req.user.tenantID, filteredRequest.userID,
      {
        withImage: true,
        ...authorizationUserFilters.filters
      },
      authorizationUserFilters.projectFields
    );
    // Check User
    UtilsService.assertObjectExists(action, user, `User ID '${filteredRequest.userID}' does not exist`,
      MODULE_NAME, 'handleCreateTag', req.user);
    // Only current organization User can be assigned to Tag
    if (!user.issuer) {
      throw new AppError({
        source: Constants.CENTRAL_SERVER,
        errorCode: HTTPError.GENERAL_ERROR,
        message: `User not issued by the organization cannot be assigned to Tag ID '${tag.id}'`,
        module: MODULE_NAME, method: 'handleCreateTag',
        user: req.user, actionOnUser: user,
        action: action
      });
    }
    // Clear default tag
    if (filteredRequest.default) {
      await TagStorage.clearDefaultUserTag(req.user.tenantID, filteredRequest.userID);
    }
    // Check default Tag
    if (!filteredRequest.default) {
      // Check if another one is the default
      const defaultTag = await TagStorage.getDefaultUserTag(req.user.tenantID, filteredRequest.userID, {
        issuer: true,
      });
      if (!defaultTag) {
        // Force default Tag
        filteredRequest.default = true;
      }
    }
    // Create
    const newTag: Tag = {
      id: filteredRequest.id.toUpperCase(),
      description: filteredRequest.description,
      issuer: true,
      active: filteredRequest.active,
      createdBy: { id: req.user.id },
      createdOn: new Date(),
      userID: filteredRequest.userID,
      default: filteredRequest.default,
      visualID: filteredRequest.visualID
    } as Tag;
    // Save
    await TagStorage.saveTag(req.user.tenantID, newTag);
    // Synchronize badges with IOP
    if (Utils.isComponentActiveFromToken(req.user, TenantComponents.OCPI)) {
      try {
        const tenant = await TenantStorage.getTenant(req.user.tenantID);
        const ocpiClient: EmspOCPIClient = await OCPIClientFactory.getAvailableOcpiClient(tenant, OCPIRole.EMSP) as EmspOCPIClient;
        if (ocpiClient) {
          await ocpiClient.pushToken({
            uid: newTag.id,
            type: OCPIUtils.getOCPITokenTypeFromID(newTag.id),
            auth_id: newTag.userID,
            visual_number: newTag.userID,
            issuer: tenant.name,
            valid: true,
            whitelist: OCPITokenWhitelist.ALLOWED_OFFLINE,
            last_updated: new Date()
          });
        }
      } catch (error) {
        await Logging.logError({
          tenantID: req.user.tenantID,
          action: action,
          module: MODULE_NAME, method: 'handleCreateTag',
          message: `Unable to synchronize tokens of user ${filteredRequest.userID} with IOP`,
          detailedMessages: { error: error.message, stack: error.stack }
        });
      }
    }
    await Logging.logSecurityInfo({
      tenantID: req.user.tenantID,
      action: action,
      user: req.user, actionOnUser: user,
      module: MODULE_NAME, method: 'handleCreateTag',
      message: `Tag with ID '${newTag.id}'has been created successfully`,
      detailedMessages: { tag: newTag }
    });
    res.status(StatusCodes.CREATED).json(Object.assign({ id: newTag.id }, Constants.REST_RESPONSE_SUCCESS));
    next();
  }

  public static async handleUpdateTag(action: ServerAction, req: Request, res: Response, next: NextFunction): Promise<void> {
    // Filter
    const filteredRequest = TagSecurity.filterTagUpdateRequest({ ...req.params, ...req.body }, req.user);
    // Check
    UtilsService.checkIfUserTagIsValid(filteredRequest, req);
    // Check and Get Tag
    const tag = await UtilsService.checkAndGetTagAuthorization(req.tenant, req.user, filteredRequest.id, Action.UPDATE, action,
      { withNbrTransactions: true, withUser: true }, true);
    // Get User authorization filters
    const authorizationUserFilters = await AuthorizationService.checkAndGetUserAuthorizationFilters(
      req.tenant, req.user, { ID: filteredRequest.userID });
    // Get the user
    const user = await UserStorage.getUser(req.user.tenantID, filteredRequest.userID,
      {
        withImage: true,
        ...authorizationUserFilters.filters
      },
      authorizationUserFilters.projectFields
    );
    // Check User
    UtilsService.assertObjectExists(action, user, `User ID '${filteredRequest.userID}' does not exist`,
      MODULE_NAME, 'handleUpdateTag', req.user);
    if (tag.visualID !== filteredRequest.visualID) {
      // Check visualID uniqueness
      const tagVisualID = await TagStorage.getTagByVisualID(req.user.tenantID, filteredRequest.visualID);
      if (tagVisualID) {
        throw new AppError({
          source: Constants.CENTRAL_SERVER,
          errorCode: HTTPError.TAG_VISUAL_ID_ALREADY_EXIST_ERROR,
          message: `Tag with visual ID '${filteredRequest.id}' already exists`,
          module: MODULE_NAME, method: 'handleCreateTag',
          user: req.user,
          action: action
        });
      }
    }
    // Only current organization User can be assigned to Tag
    if (!user.issuer) {
      throw new AppError({
        source: Constants.CENTRAL_SERVER,
        errorCode: HTTPError.GENERAL_ERROR,
        message: `User not issued by the organization cannot be assigned to Tag ID '${tag.id}'`,
        module: MODULE_NAME, method: 'handleUpdateTag',
        user: req.user, actionOnUser: user,
        action: action
      });
    }
    let formerTagUserID: string;
    let formerTagDefault: boolean;
    // Check User reassignment
    if (tag.userID !== filteredRequest.userID) {
      // Has transactions
      if (tag.transactionsCount > 0) {
        throw new AppError({
          source: Constants.CENTRAL_SERVER,
          errorCode: HTTPError.TAG_HAS_TRANSACTIONS,
          message: `Cannot change the User of the Tag ID '${tag.id}' which has '${tag.transactionsCount}' transaction(s)`,
          module: MODULE_NAME, method: 'handleUpdateTag',
          user: req.user,
          action: action
        });
      }
      formerTagUserID = tag.userID;
      formerTagDefault = tag.default;
    }
    if (filteredRequest.default && !formerTagUserID && (tag.default !== filteredRequest.default)) {
      await TagStorage.clearDefaultUserTag(req.user.tenantID, filteredRequest.userID);
    }
    // Check default Tag
    if (!filteredRequest.default) {
      // Check if another one is the default
      const defaultTag = await TagStorage.getDefaultUserTag(req.user.tenantID, filteredRequest.userID, {
        issuer: true,
      });
      if (!defaultTag) {
        // Force default Tag
        filteredRequest.default = true;
      }
    }
    // Update
    tag.visualID = filteredRequest.visualID;
    tag.description = filteredRequest.description;
    tag.active = filteredRequest.active;
    tag.userID = filteredRequest.userID;
    tag.default = filteredRequest.default;
    tag.lastChangedBy = { id: req.user.id };
    tag.lastChangedOn = new Date();
    // Save
    await TagStorage.saveTag(req.user.tenantID, tag);
    // Check former owner of the tag
    if (formerTagUserID && formerTagDefault) {
      // Clear
      await TagStorage.clearDefaultUserTag(req.user.tenantID, formerTagUserID);
      // Check default tag
      const activeTag = await TagStorage.getFirstActiveUserTag(req.user.tenantID, formerTagUserID, {
        issuer: true
      });
      // Set default
      if (activeTag) {
        activeTag.default = true;
        await TagStorage.saveTag(req.user.tenantID, activeTag);
      }
    }
    // Synchronize badges with IOP
    if (Utils.isComponentActiveFromToken(req.user, TenantComponents.OCPI) && (filteredRequest.userID !== tag.userID)) {
      try {
        const tenant = await TenantStorage.getTenant(req.user.tenantID);
        const ocpiClient: EmspOCPIClient = await OCPIClientFactory.getAvailableOcpiClient(tenant, OCPIRole.EMSP) as EmspOCPIClient;
        if (ocpiClient) {
          await ocpiClient.pushToken({
            uid: tag.id,
            type: OCPIUtils.getOCPITokenTypeFromID(tag.id),
            auth_id: tag.userID,
            visual_number: tag.userID,
            issuer: tenant.name,
            valid: tag.active,
            whitelist: OCPITokenWhitelist.ALLOWED_OFFLINE,
            last_updated: new Date()
          });
        }
      } catch (error) {
        await Logging.logError({
          tenantID: req.user.tenantID,
          action: action,
          module: MODULE_NAME, method: 'handleUpdateTag',
          user: req.user, actionOnUser: user,
          message: `Unable to synchronize tokens of user ${filteredRequest.userID} with IOP`,
          detailedMessages: { error: error.message, stack: error.stack }
        });
      }
    }
    await Logging.logSecurityInfo({
      tenantID: req.user.tenantID,
      action: action,
      module: MODULE_NAME, method: 'handleUpdateTag',
      message: `Tag with ID '${tag.id}'has been updated successfully`,
      user: req.user, actionOnUser: user,
      detailedMessages: { tag: tag }
    });
    res.json(Constants.REST_RESPONSE_SUCCESS);
    next();
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  public static async handleImportTags(action: ServerAction, req: Request, res: Response, next: NextFunction): Promise<void> {
    // Check auth
    if (!await Authorizations.canImportTags(req.user)) {
      throw new AppAuthError({
        errorCode: HTTPAuthError.FORBIDDEN,
        user: req.user,
        action: Action.IMPORT, entity: Entity.TAGS,
        module: MODULE_NAME, method: 'handleImportTags'
      });
    }
    // Acquire the lock
    const importTagsLock = await LockingHelper.createImportTagsLock(req.tenant.id);
    if (!importTagsLock) {
      throw new AppError({
        source: Constants.CENTRAL_SERVER,
        action: action,
        errorCode: HTTPError.CANNOT_ACQUIRE_LOCK,
        module: MODULE_NAME, method: 'handleImportTags',
        message: 'Error in importing the Tags: cannot acquire the lock',
        user: req.user
      });
    }
    try {
      // Default values for Tag import
      const importedBy = req.user.id;
      const importedOn = new Date();
      const tagsToBeImported: ImportedTag[] = [];
      const startTime = new Date().getTime();
      const result: ActionsResponse = {
        inSuccess: 0,
        inError: 0
      };
      // Delete all previously imported tags
      await TagStorage.deleteImportedTags(req.user.tenantID);
      // Get the stream
      const busboy = new Busboy({ headers: req.headers });
      req.pipe(busboy);
      // Handle closed socket
      let connectionClosed = false;
      // eslint-disable-next-line @typescript-eslint/no-misused-promises
      req.socket.on('close', async () => {
        if (!connectionClosed) {
          connectionClosed = true;
          // Release the lock
          await LockingManager.release(importTagsLock);
        }
      });
      // eslint-disable-next-line @typescript-eslint/no-misused-promises
      busboy.on('file', async (fieldname: string, file: any, filename: string, encoding: string, mimetype: string) => {
        if (filename.slice(-4) === '.csv') {
          const converter = csvToJson({
            trim: true,
            delimiter: Constants.CSV_SEPARATOR,
            output: 'json',
          });
          void converter.subscribe(async (tag: ImportedTag) => {
            // Check connection
            if (connectionClosed) {
              throw new Error('HTTP connection has been closed');
            }
            // Check the format of the first entry
            if (!result.inSuccess && !result.inError) {
              // Check header
              const tagKeys = Object.keys(tag);
              if (!TagRequiredImportProperties.every((property) => tagKeys.includes(property))) {
                if (!res.headersSent) {
                  res.writeHead(HTTPError.INVALID_FILE_CSV_HEADER_FORMAT);
                  res.end();
                }
                throw new Error(`Missing one of required properties: '${TagRequiredImportProperties.join(', ')}'`);
              }
            }
            // Set default value
            tag.importedBy = importedBy;
            tag.importedOn = importedOn;
            // Import
            const importSuccess = await TagService.processTag(action, req, tag, tagsToBeImported);
            if (!importSuccess) {
              result.inError++;
            }
            // Insert batched
            if (!Utils.isEmptyArray(tagsToBeImported) && (tagsToBeImported.length % Constants.IMPORT_BATCH_INSERT_SIZE) === 0) {
              await TagService.insertTags(req.user.tenantID, req.user, action, tagsToBeImported, result);
            }
          // eslint-disable-next-line @typescript-eslint/no-misused-promises
          }, async (error: CSVError) => {
            // Release the lock
            await LockingManager.release(importTagsLock);
            // Log
            await Logging.logError({
              tenantID: req.user.tenantID,
              module: MODULE_NAME, method: 'handleImportTags',
              action: action,
              user: req.user.id,
              message: `Exception while parsing the CSV '${filename}': ${error.message}`,
              detailedMessages: { error: error.message, stack: error.stack }
            });
            if (!res.headersSent) {
              res.writeHead(HTTPError.INVALID_FILE_FORMAT);
              res.end();
            }
          // Completed
          // eslint-disable-next-line @typescript-eslint/no-misused-promises
          }, async () => {
            // Consider the connection closed
            connectionClosed = true;
            // Insert batched
            if (tagsToBeImported.length > 0) {
              await TagService.insertTags(req.user.tenantID, req.user, action, tagsToBeImported, result);
            }
            // Release the lock
            await LockingManager.release(importTagsLock);
            // Log
            const executionDurationSecs = Utils.truncTo((new Date().getTime() - startTime) / 1000, 2);
            await Logging.logActionsResponse(
              req.user.tenantID, action,
              MODULE_NAME, 'handleImportTags', result,
              `{{inSuccess}} Tag(s) were successfully uploaded in ${executionDurationSecs}s and ready for asynchronous import`,
              `{{inError}} Tag(s) failed to be uploaded in ${executionDurationSecs}s`,
              `{{inSuccess}}  Tag(s) were successfully uploaded in ${executionDurationSecs}s and ready for asynchronous import and {{inError}} failed to be uploaded`,
              `No Tag have been uploaded in ${executionDurationSecs}s`, req.user
            );
            // Create and Save async task
            await AsyncTaskManager.createAndSaveAsyncTasks({
              name: AsyncTasks.TAGS_IMPORT,
              action: ServerAction.TAGS_IMPORT,
              type: AsyncTaskType.TASK,
              tenantID: req.tenant.id,
              module: MODULE_NAME,
              method: 'handleImportTags',
            });
            // Respond
            res.json({ ...result, ...Constants.REST_RESPONSE_SUCCESS });
            next();
          });
          // Start processing the file
          void file.pipe(converter);
        } else if (mimetype === 'application/json') {
          const parser = JSONStream.parse('tags.*');
          // TODO: Handle the end of the process to send the data like the CSV
          // eslint-disable-next-line @typescript-eslint/no-misused-promises
          parser.on('data', async (tag: ImportedTag) => {
            // Set default value
            tag.importedBy = importedBy;
            tag.importedOn = importedOn;
            // Import
            const importSuccess = await TagService.processTag(action, req, tag, tagsToBeImported);
            if (!importSuccess) {
              result.inError++;
            }
            // Insert batched
            if ((tagsToBeImported.length % Constants.IMPORT_BATCH_INSERT_SIZE) === 0) {
              await TagService.insertTags(req.user.tenantID, req.user, action, tagsToBeImported, result);
            }
          });
          // eslint-disable-next-line @typescript-eslint/no-misused-promises
          parser.on('error', async (error) => {
            // Release the lock
            await LockingManager.release(importTagsLock);
            // Log
            await Logging.logError({
              tenantID: req.user.tenantID,
              module: MODULE_NAME, method: 'handleImportTags',
              action: action,
              user: req.user.id,
              message: `Invalid Json file '${filename}'`,
              detailedMessages: { error: error.message, stack: error.stack }
            });
            if (!res.headersSent) {
              res.writeHead(HTTPError.INVALID_FILE_FORMAT);
              res.end();
            }
          });
          file.pipe(parser);
        } else {
          // Release the lock
          await LockingManager.release(importTagsLock);
          // Log
          await Logging.logError({
            tenantID: req.user.tenantID,
            module: MODULE_NAME, method: 'handleImportTags',
            action: action,
            user: req.user.id,
            message: `Invalid file format '${mimetype}'`
          });
          if (!res.headersSent) {
            res.writeHead(HTTPError.INVALID_FILE_FORMAT);
            res.end();
          }
        }
      });
    } catch (error) {
      // Release the lock
      await LockingManager.release(importTagsLock);
      throw error;
    }
  }

  public static async handleExportTags(action: ServerAction, req: Request, res: Response, next: NextFunction): Promise<void> {
    // Check auth
    if (!await Authorizations.canExportTags(req.user)) {
      throw new AppAuthError({
        errorCode: HTTPAuthError.FORBIDDEN,
        user: req.user,
        action: Action.IMPORT, entity: Entity.TAGS,
        module: MODULE_NAME, method: 'handleImportTags'
      });
    }
    // Export with users
    await UtilsService.exportToCSV(req, res, 'exported-tags.csv',
      TagService.getTags.bind(this),
      TagService.convertToCSV.bind(this));
  }

  private static async insertTags(tenantID: string, user: UserToken, action: ServerAction, tagsToBeImported: ImportedTag[], result: ActionsResponse): Promise<void> {
    try {
      const nbrInsertedTags = await TagStorage.saveImportedTags(tenantID, tagsToBeImported);
      result.inSuccess += nbrInsertedTags;
    } catch (error) {
      // Handle dup keys
      result.inSuccess += error.result.nInserted;
      result.inError += error.writeErrors.length;
      await Logging.logError({
        tenantID: tenantID,
        module: MODULE_NAME, method: 'insertTags',
        action: action,
        user: user.id,
        message: `Cannot import ${error.writeErrors.length as number} tags!`,
        detailedMessages: { error: error.message, stack: error.stack, tagsError: error.writeErrors }
      });
    }
    tagsToBeImported.length = 0;
  }

  private static async deleteTags(tenant: Tenant, action: ServerAction, loggedUser: UserToken, tagsIDs: string[]): Promise<ActionsResponse> {
    const result: ActionsResponse = {
      inSuccess: 0,
      inError: 0
    };
    // Delete Tags
    for (const tagID of tagsIDs) {
      // Check and Get Tag
      const tag = await UtilsService.checkAndGetTagAuthorization(tenant, loggedUser, tagID, Action.DELETE, action,
        { withUser: true }, true);
      // Not Found
      if (!tag) {
        result.inError++;
        await Logging.logError({
          tenantID: loggedUser.tenantID,
          user: loggedUser,
          module: MODULE_NAME, method: 'handleDeleteTags',
          message: `Tag ID '${tagID}' does not exist`,
          action: action,
          detailedMessages: { tag }
        });
        continue;
      }
      if (!tag.issuer) {
        result.inError++;
        await Logging.logError({
          tenantID: loggedUser.tenantID,
          user: loggedUser,
          module: MODULE_NAME, method: 'handleDeleteTags',
          message: `Tag ID '${tag.id}' not issued by the organization`,
          action: action,
          detailedMessages: { tag }
        });
        continue;
      }
      // OCPI
      if (Utils.isComponentActiveFromToken(loggedUser, TenantComponents.OCPI)) {
        try {
          const issuerTenant = await TenantStorage.getTenant(loggedUser.tenantID);
          const ocpiClient: EmspOCPIClient = await OCPIClientFactory.getAvailableOcpiClient(issuerTenant, OCPIRole.EMSP) as EmspOCPIClient;
          if (ocpiClient) {
            await ocpiClient.pushToken({
              uid: tag.id,
              type: OCPIUtils.getOCPITokenTypeFromID(tag.id),
              auth_id: tag.userID,
              visual_number: tag.userID,
              issuer: issuerTenant.name,
              valid: false,
              whitelist: OCPITokenWhitelist.ALLOWED_OFFLINE,
              last_updated: new Date()
            });
          }
        } catch (error) {
          await Logging.logError({
            tenantID: loggedUser.tenantID,
            module: MODULE_NAME, method: 'handleDeleteTags',
            action: action,
            message: `Unable to synchronize tokens of user ${tag.userID} with IOP`,
            detailedMessages: { error: error.message, stack: error.stack }
          });
        }
      }
      // Delete the Tag
      await TagStorage.deleteTag(loggedUser.tenantID, tag.id);
      result.inSuccess++;
      // Check if the default Tag has been deleted?
      if (tag.default) {
        // Clear default User's Tags
        await TagStorage.clearDefaultUserTag(loggedUser.tenantID, tag.userID);
        // Make the first active User's Tag
        const firstActiveTag = await TagStorage.getFirstActiveUserTag(loggedUser.tenantID, tag.userID, {
          issuer: true,
        });
        // Set it default
        if (firstActiveTag) {
          firstActiveTag.default = true;
          await TagStorage.saveTag(loggedUser.tenantID, firstActiveTag);
        }
      }
    }
    // Log
    await Logging.logActionsResponse(loggedUser.tenantID,
      ServerAction.TAGS_DELETE,
      MODULE_NAME, 'handleDeleteTags', result,
      '{{inSuccess}} tag(s) were successfully deleted',
      '{{inError}} tag(s) failed to be deleted',
      '{{inSuccess}} tag(s) were successfully deleted and {{inError}} failed to be deleted',
      'No tags have been deleted', loggedUser
    );
    return result;
  }

  private static convertToCSV(req: Request, tags: Tag[], writeHeader = true): string {
    let headers = null;
    // Header
    if (writeHeader) {
      headers = [
        'id',
        'visual ID',
        'description',
        'firstName',
        'name',
        'email',
      ].join(Constants.CSV_SEPARATOR);
    }
    // Content
    const rows = tags.map((tag) => {
      const row = [
        tag.id,
        tag.visualID,
        tag.description,
        tag.user?.firstName,
        tag.user?.name,
        tag.user?.email
      ].map((value) => Utils.escapeCsvValue(value));
      return row;
    }).join(Constants.CR_LF);
    return Utils.isNullOrUndefined(headers) ? Constants.CR_LF + rows : [headers, rows].join(Constants.CR_LF);
  }

  private static async getTags(req: Request): Promise<DataResult<Tag>> {
    // Filter
    const filteredRequest = TagSecurity.filterTagsRequest(req.query);
    // Get authorization filters
    const authorizationTagsFilters = await AuthorizationService.checkAndGetTagsAuthorizationFilters(
      req.tenant, req.user, filteredRequest);
    if (!authorizationTagsFilters.authorized) {
      throw new AppAuthError({
        errorCode: HTTPAuthError.FORBIDDEN,
        user: req.user,
        action: Action.LIST, entity: Entity.TAGS,
        module: MODULE_NAME, method: 'getTags'
      });
    }
    // Get authorization filters for users
    const authorizationUsersFilters = await AuthorizationService.checkAndGetUsersAuthorizationFilters(
      req.tenant, req.user, {});
    if (authorizationUsersFilters.authorized) {
      authorizationTagsFilters.projectFields.push('userID', 'user.id', 'user.name', 'user.firstName', 'user.email',
        'createdBy.name', 'createdBy.firstName', 'lastChangedBy.name', 'lastChangedBy.firstName');
    }
    // Get the tags
    const tags = await TagStorage.getTags(req.user.tenantID,
      {
        search: filteredRequest.Search,
        issuer: filteredRequest.Issuer,
        active: filteredRequest.Active,
        withUser: filteredRequest.WithUser,
        ...authorizationTagsFilters.filters
      },
      {
        limit: filteredRequest.Limit,
        skip: filteredRequest.Skip,
        sort: filteredRequest.SortFields,
        onlyRecordCount: filteredRequest.OnlyRecordCount
      },
      authorizationTagsFilters.projectFields,
    );
    // Add Auth flags
    await AuthorizationService.addTagsAuthorizations(req.tenant, req.user, tags as TagDataResult, authorizationTagsFilters);
    // Return
    return tags;
  }

  private static async processTag(action: ServerAction, req: Request, importedTag: ImportedTag, tagsToBeImported: ImportedTag[]): Promise<boolean> {
    try {
      const newImportedTag: ImportedTag = {
        id: importedTag.id.toUpperCase(),
        visualID: importedTag.visualID,
        description: importedTag.description ? importedTag.description : `Badge ID '${importedTag.id}'`,
        name: importedTag.name.toUpperCase(),
        firstName: importedTag.firstName,
        email: importedTag.email,
      };
      // Validate Tag data
      TagValidator.getInstance().validateImportedTagCreation(newImportedTag);
      // Set properties
      newImportedTag.importedBy = importedTag.importedBy;
      newImportedTag.importedOn = importedTag.importedOn;
      newImportedTag.status = ImportStatus.READY;
      try {
        UserValidator.getInstance().validateImportedUserCreation(newImportedTag as ImportedUser);
      } catch (error) {
        newImportedTag.email = '';
        newImportedTag.name = '';
        newImportedTag.firstName = '';
        await Logging.logWarning({
          tenantID: req.user.tenantID,
          module: MODULE_NAME, method: 'processTag',
          action: action,
          message: `User cannot be imported tag ${newImportedTag.id}`,
          detailedMessages: { tag: newImportedTag, error: error.message, stack: error.stack }
        });
      }
      // Save it later on
      tagsToBeImported.push(newImportedTag);
      return true;
    } catch (error) {
      await Logging.logError({
        tenantID: req.user.tenantID,
        module: MODULE_NAME, method: 'importTag',
        action: action,
        message: `Tag ID '${importedTag.id}' cannot be imported`,
        detailedMessages: { tag: importedTag, error: error.message, stack: error.stack }
      });
      return false;
    }
  }
}
