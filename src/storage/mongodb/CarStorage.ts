import { Car, CarCatalog, CarCatalogChargeAlternativeTable, CarCatalogChargeOptionTable, CarCatalogConverter, CarMaker, CarType } from '../../types/Car';
import global, { FilterParams, Image } from '../../types/GlobalType';

import Constants from '../../utils/Constants';
import Cypher from '../../utils/Cypher';
import { DataResult } from '../../types/DataResult';
import DatabaseUtils from './DatabaseUtils';
import DbParams from '../../types/database/DbParams';
import Logging from '../../utils/Logging';
import { ObjectID } from 'mongodb';
import { UserCar } from '../../types/User';
import Utils from '../../utils/Utils';

const MODULE_NAME = 'CarStorage';

export default class CarStorage {
  public static async getCarCatalog(id: number = Constants.UNKNOWN_NUMBER_ID,
      params: { withImage?: boolean; } = {},
      projectFields?: string[]): Promise<CarCatalog> {
    const carCatalogsMDB = await CarStorage.getCarCatalogs({
      carCatalogIDs: [id],
      withImage: params.withImage,
    }, Constants.DB_PARAMS_SINGLE_RECORD, projectFields);
    return carCatalogsMDB.count === 1 ? carCatalogsMDB.result[0] : null;
  }

  public static async getCarCatalogs(
      params: { search?: string; carCatalogIDs?: number[]; carMaker?: string[], withImage?: boolean; } = {},
      dbParams?: DbParams, projectFields?: string[]): Promise<DataResult<CarCatalog>> {
    // Debug
    const uniqueTimerID = Logging.traceStart(Constants.DEFAULT_TENANT, MODULE_NAME, 'getCarCatalogs');
    // Clone before updating the values
    dbParams = Utils.cloneObject(dbParams);
    // Check Limit
    dbParams.limit = Utils.checkRecordLimit(dbParams.limit);
    // Check Skip
    dbParams.skip = Utils.checkRecordSkip(dbParams.skip);
    // Create Aggregation
    const aggregation = [];
    // Set the filters
    const filters: FilterParams = {};
    if (params.search) {
      filters.$or = [
        { '_id': Utils.convertToInt(params.search) },
        { 'vehicleModel': { $regex: params.search, $options: 'i' } },
        { 'vehicleMake': { $regex: params.search, $options: 'i' } },
        { 'vehicleModelVersion': { $regex: params.search, $options: 'i' } },
      ];
    }
    // Limit on Car for Basic Users
    if (!Utils.isEmptyArray(params.carCatalogIDs)) {
      aggregation.push({
        $match: {
          _id: { $in: params.carCatalogIDs.map((carCatalogID) => Utils.convertToInt(carCatalogID)) }
        }
      });
    }
    if (params.carMaker) {
      aggregation.push({
        $match: {
          'vehicleMake': { $in: params.carMaker }
        }
      });
    }
    // Filters
    aggregation.push({
      $match: filters
    });
    // Limit records?
    if (!dbParams.onlyRecordCount) {
      // Always limit the nbr of record to avoid perfs issues
      aggregation.push({ $limit: Constants.DB_RECORD_COUNT_CEIL });
    }
    // Count Records
    const carCatalogsCountMDB = await global.database.getCollection<DataResult<CarCatalog>>(Constants.DEFAULT_TENANT, 'carcatalogs')
      .aggregate([...aggregation, { $count: 'count' }], { allowDiskUse: true })
      .toArray();
    // Check if only the total count is requested
    if (dbParams.onlyRecordCount) {
      // Return only the count
      await Logging.traceEnd(Constants.DEFAULT_TENANT, MODULE_NAME, 'getCarCatalogs', uniqueTimerID, carCatalogsCountMDB);
      return {
        count: (carCatalogsCountMDB.length > 0 ? carCatalogsCountMDB[0].count : 0),
        result: []
      };
    }
    // Remove the limit
    aggregation.pop();
    // Sort
    if (!dbParams.sort) {
      dbParams.sort = { name: 1 };
    }
    aggregation.push({
      $sort: dbParams.sort
    });
    // Skip
    if (dbParams.skip > 0) {
      aggregation.push({ $skip: dbParams.skip });
    }
    // Limit
    aggregation.push({
      $limit: (dbParams.limit > 0 && dbParams.limit < Constants.DB_RECORD_COUNT_CEIL) ? dbParams.limit : Constants.DB_RECORD_COUNT_CEIL
    });
    // Car Image
    if (params.withImage) {
      aggregation.push({
        $addFields: {
          image: {
            $cond: {
              if: { $gt: ['$image', null] }, then: {
                $concat: [
                  `${Utils.buildRestServerURL()}/client/util/CarCatalogImage?ID=`,
                  { $toString: '$_id' },
                  '&LastChangedOn=',
                  { $toString: '$lastChangedOn' }
                ]
              }, else: null
            }

          }
        }
      });
    }
    // Add Created By / Last Changed By
    DatabaseUtils.pushCreatedLastChangedInAggregation(Constants.DEFAULT_TENANT, aggregation);
    // Handle the ID
    DatabaseUtils.pushRenameDatabaseID(aggregation);
    // Project
    DatabaseUtils.projectFields(aggregation, projectFields);
    // Read DB
    const carCatalogs = await global.database.getCollection<any>(Constants.DEFAULT_TENANT, 'carcatalogs')
      .aggregate(aggregation, {
        allowDiskUse: true
      })
      .toArray();
    // Debug
    await Logging.traceEnd(Constants.DEFAULT_TENANT, MODULE_NAME, 'getCarCatalogs', uniqueTimerID, carCatalogs);
    // Ok
    return {
      count: (carCatalogsCountMDB.length > 0 ?
        (carCatalogsCountMDB[0].count === Constants.DB_RECORD_COUNT_CEIL ? -1 : carCatalogsCountMDB[0].count) : 0),
      result: carCatalogs
    };
  }

  public static async saveCarCatalog(carToSave: CarCatalog): Promise<number> {
    // Debug
    const uniqueTimerID = Logging.traceStart(Constants.DEFAULT_TENANT, MODULE_NAME, 'saveCarCatalog');
    // Build Request
    // Properties to save
    const carMDB: any = {
      _id: Utils.convertToInt(carToSave.id),
      vehicleMake: carToSave.vehicleMake,
      vehicleModel: carToSave.vehicleModel,
      vehicleModelVersion: carToSave.vehicleModelVersion,
      availabilityStatus: carToSave.availabilityStatus,
      availabilityDateFrom: carToSave.availabilityDateFrom,
      availabilityDateTo: carToSave.availabilityDateTo,
      priceFromDE: Utils.convertToFloat(carToSave.priceFromDE),
      priceFromDEEstimate: carToSave.priceFromDEEstimate,
      priceFromNL: Utils.convertToFloat(carToSave.priceFromNL),
      priceFromNLEstimate: carToSave.priceFromNLEstimate,
      priceFromUK: Utils.convertToFloat(carToSave.priceFromUK),
      priceGrantPICGUK: Utils.convertToFloat(carToSave.priceGrantPICGUK),
      priceFromUKEstimate: carToSave.priceFromUKEstimate,
      drivetrainType: carToSave.drivetrainType,
      drivetrainFuel: carToSave.drivetrainFuel,
      drivetrainPropulsion: carToSave.drivetrainPropulsion,
      drivetrainPower: Utils.convertToInt(carToSave.drivetrainPower),
      drivetrainPowerHP: Utils.convertToInt(carToSave.drivetrainPowerHP),
      drivetrainTorque: Utils.convertToInt(carToSave.drivetrainTorque),
      performanceAcceleration: Utils.convertToFloat(carToSave.performanceAcceleration),
      performanceTopspeed: Utils.convertToInt(carToSave.performanceTopspeed),
      rangeWLTP: Utils.convertToInt(carToSave.rangeWLTP),
      rangeWLTPEstimate: carToSave.rangeWLTPEstimate,
      rangeNEDC: Utils.convertToInt(carToSave.rangeNEDC),
      rangeNEDCEstimate: carToSave.rangeNEDCEstimate,
      rangeReal: Utils.convertToInt(carToSave.rangeReal),
      rangeRealMode: carToSave.rangeRealMode,
      rangeRealWHwy: carToSave.rangeRealWHwy,
      rangeRealWCmb: carToSave.rangeRealWCmb,
      rangeRealWCty: carToSave.rangeRealWCty,
      rangeRealBHwy: carToSave.rangeRealBHwy,
      rangeRealBCmb: carToSave.rangeRealBCmb,
      rangeRealBCty: carToSave.rangeRealBCty,
      efficiencyWLTP: Utils.convertToFloat(carToSave.efficiencyWLTP),
      efficiencyWLTPFuelEq: Utils.convertToFloat(carToSave.efficiencyWLTPFuelEq),
      efficiencyWLTPV: Utils.convertToFloat(carToSave.efficiencyWLTPV),
      efficiencyWLTPFuelEqV: Utils.convertToFloat(carToSave.efficiencyWLTPFuelEqV),
      efficiencyWLTPCO2: Utils.convertToFloat(carToSave.efficiencyWLTPCO2),
      efficiencyNEDC: Utils.convertToFloat(carToSave.efficiencyNEDC),
      efficiencyNEDCFuelEq: Utils.convertToFloat(carToSave.efficiencyNEDCFuelEq),
      efficiencyNEDCV: Utils.convertToFloat(carToSave.efficiencyNEDCV),
      efficiencyNEDCFuelEqV: Utils.convertToFloat(carToSave.efficiencyNEDCFuelEqV),
      efficiencyNEDCCO2: Utils.convertToFloat(carToSave.efficiencyNEDCCO2),
      efficiencyReal: Utils.convertToFloat(carToSave.efficiencyReal),
      efficiencyRealFuelEqV: Utils.convertToFloat(carToSave.efficiencyRealFuelEqV),
      efficiencyRealCO2: Utils.convertToFloat(carToSave.efficiencyRealCO2),
      efficiencyRealWHwy: Utils.convertToFloat(carToSave.efficiencyRealWHwy),
      efficiencyRealWCmb: Utils.convertToFloat(carToSave.efficiencyRealWCmb),
      efficiencyRealWCty: Utils.convertToFloat(carToSave.efficiencyRealWCty),
      efficiencyRealBHwy: Utils.convertToFloat(carToSave.efficiencyRealBHwy),
      efficiencyRealBCmb: Utils.convertToFloat(carToSave.efficiencyRealBCmb),
      efficiencyRealBCty: Utils.convertToFloat(carToSave.efficiencyRealBCty),
      chargePlug: carToSave.chargePlug,
      chargePlugEstimate: carToSave.chargePlugEstimate,
      chargePlugLocation: carToSave.chargePlugLocation,
      chargeStandardPower: Utils.convertToFloat(carToSave.chargeStandardPower),
      chargeStandardPhase: Utils.convertToInt(carToSave.chargeStandardPhase),
      chargeStandardPhaseAmp: Utils.convertToInt(carToSave.chargeStandardPhaseAmp),
      chargeStandardChargeTime: Utils.convertToInt(carToSave.chargeStandardChargeTime),
      chargeStandardChargeSpeed: Utils.convertToInt(carToSave.chargeStandardChargeSpeed),
      chargeStandardEstimate: carToSave.chargeStandardEstimate,
      chargeStandardTables: carToSave.chargeStandardTables ?
        carToSave.chargeStandardTables.map((chargeStandardTable: CarCatalogConverter): CarCatalogConverter => ({
          type: chargeStandardTable.type,
          evsePhaseVolt: Utils.convertToInt(chargeStandardTable.evsePhaseVolt),
          evsePhaseAmp: Utils.convertToInt(chargeStandardTable.evsePhaseAmp),
          evsePhase: Utils.convertToInt(chargeStandardTable.evsePhase),
          evsePhaseVoltCalculated: Utils.convertToInt(chargeStandardTable.evsePhaseVoltCalculated),
          chargePhaseVolt: Utils.convertToInt(chargeStandardTable.chargePhaseVolt),
          chargePhaseAmp: Utils.convertToInt(chargeStandardTable.chargePhaseAmp),
          chargePhase: Utils.convertToInt(chargeStandardTable.chargePhase),
          chargePower: Utils.convertToFloat(chargeStandardTable.chargePower),
          chargeTime: Utils.convertToInt(chargeStandardTable.chargeTime),
          chargeSpeed: Utils.convertToInt(chargeStandardTable.chargeSpeed)
        })) : [],
      chargeAlternativePower: Utils.convertToInt(carToSave.chargeAlternativePower),
      chargeAlternativePhase: Utils.convertToInt(carToSave.chargeAlternativePhase),
      chargeAlternativePhaseAmp: Utils.convertToInt(carToSave.chargeAlternativePhaseAmp),
      chargeAlternativeChargeTime: Utils.convertToInt(carToSave.chargeAlternativeChargeTime),
      chargeAlternativeChargeSpeed: Utils.convertToInt(carToSave.chargeAlternativeChargeSpeed),
      chargeAlternativeTables: carToSave.chargeAlternativeTables ?
        carToSave.chargeAlternativeTables.map((chargeAlternativeTable: CarCatalogChargeAlternativeTable): CarCatalogChargeAlternativeTable => ({
          type: chargeAlternativeTable.type,
          evsePhaseVolt: Utils.convertToInt(chargeAlternativeTable.evsePhaseVolt),
          evsePhaseAmp: Utils.convertToInt(chargeAlternativeTable.evsePhaseAmp),
          evsePhase: Utils.convertToInt(chargeAlternativeTable.evsePhase),
          chargePhaseVolt: Utils.convertToInt(chargeAlternativeTable.chargePhaseVolt),
          chargePhaseAmp: Utils.convertToInt(chargeAlternativeTable.chargePhaseAmp),
          chargePhase: Utils.convertToInt(chargeAlternativeTable.chargePhase),
          chargePower: Utils.convertToFloat(chargeAlternativeTable.chargePower),
          chargeTime: Utils.convertToInt(chargeAlternativeTable.chargeTime),
          chargeSpeed: Utils.convertToInt(chargeAlternativeTable.chargeSpeed)
        })) : [],
      chargeOptionPower: Utils.convertToInt(carToSave.chargeOptionPower),
      chargeOptionPhase: Utils.convertToInt(carToSave.chargeOptionPhase),
      chargeOptionPhaseAmp: Utils.convertToInt(carToSave.chargeOptionPhaseAmp),
      chargeOptionChargeTime: Utils.convertToInt(carToSave.chargeOptionChargeTime),
      chargeOptionChargeSpeed: Utils.convertToInt(carToSave.chargeOptionChargeSpeed),
      chargeOptionTables: carToSave.chargeOptionTables ?
        carToSave.chargeOptionTables.map((chargeOptionTables: CarCatalogChargeOptionTable): CarCatalogChargeOptionTable => ({
          type: chargeOptionTables.type,
          evsePhaseVolt: Utils.convertToInt(chargeOptionTables.evsePhaseVolt),
          evsePhaseAmp: Utils.convertToInt(chargeOptionTables.evsePhaseAmp),
          evsePhase: Utils.convertToInt(chargeOptionTables.evsePhase),
          chargePhaseVolt: Utils.convertToInt(chargeOptionTables.chargePhaseVolt),
          chargePhaseAmp: Utils.convertToInt(chargeOptionTables.chargePhaseAmp),
          chargePhase: Utils.convertToInt(chargeOptionTables.chargePhase),
          chargePower: Utils.convertToFloat(chargeOptionTables.chargePower),
          chargeTime: Utils.convertToInt(chargeOptionTables.chargeTime),
          chargeSpeed: Utils.convertToInt(chargeOptionTables.chargeSpeed)
        })) : [],
      fastChargePlug: carToSave.fastChargePlug,
      fastChargePlugEstimate: carToSave.fastChargePlugEstimate,
      fastChargePlugLocation: carToSave.fastChargePlugLocation,
      fastChargePowerMax: Utils.convertToInt(carToSave.fastChargePowerMax),
      fastChargePowerAvg: Utils.convertToInt(carToSave.fastChargePowerAvg),
      fastChargeTime: Utils.convertToInt(carToSave.fastChargeTime),
      fastChargeSpeed: Utils.convertToInt(carToSave.fastChargeSpeed),
      fastChargeOptional: carToSave.fastChargeOptional,
      fastChargeEstimate: carToSave.fastChargeEstimate,
      batteryCapacityUseable: Utils.convertToFloat(carToSave.batteryCapacityUseable),
      batteryCapacityFull: Utils.convertToFloat(carToSave.batteryCapacityFull),
      batteryCapacityEstimate: carToSave.batteryCapacityEstimate,
      dimsLength: Utils.convertToInt(carToSave.dimsLength),
      dimsWidth: Utils.convertToInt(carToSave.dimsWidth),
      dimsHeight: Utils.convertToInt(carToSave.dimsHeight),
      dimsWheelbase: carToSave.dimsWheelbase,
      dimsWeight: Utils.convertToInt(carToSave.dimsWeight),
      dimsBootspace: Utils.convertToInt(carToSave.dimsBootspace),
      dimsBootspaceMax: Utils.convertToInt(carToSave.dimsBootspaceMax),
      dimsTowWeightUnbraked: Utils.convertToInt(carToSave.dimsTowWeightUnbraked),
      dimsTowWeightBraked: Utils.convertToInt(carToSave.dimsTowWeightBraked),
      dimsRoofLoadMax: Utils.convertToInt(carToSave.dimsRoofLoadMax),
      miscBody: carToSave.miscBody,
      miscSegment: carToSave.miscSegment,
      miscSeats: Utils.convertToInt(carToSave.miscSeats),
      miscRoofrails: carToSave.miscRoofrails,
      miscIsofix: carToSave.miscIsofix,
      miscIsofixSeats: carToSave.miscIsofixSeats,
      miscTurningCircle: carToSave.miscTurningCircle,
      euroNCAPRating: Utils.convertToInt(carToSave.euroNCAPRating),
      euroNCAPYear: carToSave.euroNCAPYear,
      euroNCAPAdult: Utils.convertToInt(carToSave.euroNCAPAdult),
      euroNCAPChild: Utils.convertToInt(carToSave.euroNCAPChild),
      euroNCAPVRU: Utils.convertToInt(carToSave.euroNCAPVRU),
      euroNCAPSA: Utils.convertToInt(carToSave.euroNCAPSA),
      relatedVehicleIDSuccessor: Utils.convertToInt(carToSave.relatedVehicleIDSuccessor),
      eVDBDetailURL: carToSave.eVDBDetailURL,
      videos: carToSave.videos,
      hash: carToSave.hash,
      imageURLs: carToSave.imageURLs,
      image: carToSave.image,
      imagesHash: carToSave.imagesHash
    };
    // Add Last Changed/Created props
    DatabaseUtils.addLastChangedCreatedProps(carMDB, carToSave);
    // Modify and return the modified document
    await global.database.getCollection<any>(Constants.DEFAULT_TENANT, 'carcatalogs').findOneAndReplace(
      { _id: Utils.convertToInt(carToSave.id) },
      carMDB,
      { upsert: true }
    );
    // Debug
    await Logging.traceEnd(Constants.DEFAULT_TENANT, MODULE_NAME, 'saveCarCatalog', uniqueTimerID, carMDB);
    return carToSave.id;
  }

  public static async saveCarImage(carID: number, carImageToSave: string): Promise<void> {
    // Debug
    const uniqueTimerID = Logging.traceStart(Constants.DEFAULT_TENANT, MODULE_NAME, 'saveCarImage');
    // Save new image
    await global.database.getCollection<any>(Constants.DEFAULT_TENANT, 'carcatalogimages').findOneAndReplace(
      { _id: Cypher.hash(`${carImageToSave}~${carID}`), },
      { carID: Utils.convertToInt(carID), image: carImageToSave },
      { upsert: true }
    );
    // Debug
    await Logging.traceEnd(Constants.DEFAULT_TENANT, MODULE_NAME, 'saveCarImage', uniqueTimerID, carImageToSave);
  }

  public static async deleteCarImages(carID: number): Promise<void> {
    // Debug
    const uniqueTimerID = Logging.traceStart(Constants.DEFAULT_TENANT, MODULE_NAME, 'deleteCarImages');
    // Delete car catalogs images
    await global.database.getCollection<any>(Constants.DEFAULT_TENANT, 'carcatalogimages').deleteMany(
      { carID: Utils.convertToInt(carID) }
    );
    // Debug
    await Logging.traceEnd(Constants.DEFAULT_TENANT, MODULE_NAME, 'deleteCarImages', uniqueTimerID, carID);
  }

  public static async getCarCatalogImage(id: number): Promise<{ id: number; image: string }> {
    // Debug
    const uniqueTimerID = Logging.traceStart(Constants.DEFAULT_TENANT, MODULE_NAME, 'getCarCatalogImage');
    // Read DB
    const carCatalogImageMDB = await global.database.getCollection<{ _id: number; image: string }>(Constants.DEFAULT_TENANT, 'carcatalogs')
      .findOne({ _id: id });
    // Debug
    await Logging.traceEnd(Constants.DEFAULT_TENANT, MODULE_NAME, 'getCarCatalogImage', uniqueTimerID, carCatalogImageMDB);
    return {
      id: id,
      image: carCatalogImageMDB ? carCatalogImageMDB.image : null
    };
  }

  public static async getCarCatalogImages(id: number = Constants.UNKNOWN_NUMBER_ID, dbParams?: DbParams): Promise<DataResult<Image>> {
    // Debug
    const uniqueTimerID = Logging.traceStart(Constants.DEFAULT_TENANT, MODULE_NAME, 'getCarCatalogImages');
    // Clone before updating the values
    dbParams = Utils.cloneObject(dbParams);
    // Check Limit
    dbParams.limit = Utils.checkRecordLimit(dbParams.limit);
    // Check Skip
    dbParams.skip = Utils.checkRecordSkip(dbParams.skip);
    // Set the filters
    const filters = {
      carID: Utils.convertToInt(id)
    };
    // Create Aggregation
    const aggregation = [];
    // Filters
    aggregation.push({
      $match: filters
    });
    // Limit records?
    if (!dbParams.onlyRecordCount) {
      aggregation.push({ $limit: Constants.DB_RECORD_COUNT_CEIL });
    }
    // Count Records
    const carCatalogImagesCountMDB = await global.database.getCollection<any>(Constants.DEFAULT_TENANT, 'carcatalogimages')
      .aggregate([...aggregation, { $count: 'count' }], { allowDiskUse: true })
      .toArray();
    // Check if only the total count is requested
    if (dbParams.onlyRecordCount) {
      await Logging.traceEnd(Constants.DEFAULT_TENANT, MODULE_NAME, 'getCarCatalogImages', uniqueTimerID, carCatalogImagesCountMDB);
      return {
        count: (carCatalogImagesCountMDB.length > 0 ? carCatalogImagesCountMDB[0].count : 0),
        result: []
      };
    }
    // Remove the limit
    aggregation.pop();
    // Handle the ID
    DatabaseUtils.pushRenameDatabaseID(aggregation);
    // Skip
    aggregation.push({
      $skip: dbParams.skip
    });
    // Limit
    aggregation.push({
      $limit: dbParams.limit
    });
    // Project
    DatabaseUtils.projectFields(aggregation, ['image']);
    // Read DB
    const carCatalogImages = await global.database.getCollection<any>(Constants.DEFAULT_TENANT, 'carcatalogimages')
      .aggregate(aggregation, {
        allowDiskUse: true
      })
      .toArray();
    // Debug
    await Logging.traceEnd(Constants.DEFAULT_TENANT, MODULE_NAME, 'getCarCatalogImages', uniqueTimerID, carCatalogImages);
    return {
      count: (carCatalogImagesCountMDB.length > 0 ?
        (carCatalogImagesCountMDB[0].count === Constants.DB_RECORD_COUNT_CEIL ? -1 : carCatalogImagesCountMDB[0].count) : 0),
      result: carCatalogImages
    };
  }

  public static async getCarMakers(params: { search?: string } = {}, projectFields?: string[]): Promise<DataResult<CarMaker>> {
    // Debug
    const uniqueTimerID = Logging.traceStart(Constants.DEFAULT_TENANT, MODULE_NAME, 'getCarMakers');
    // Set the filters
    const filters: ({ $or?: any[] } | undefined) = {};
    if (params.search) {
      filters.$or = [
        { 'vehicleMake': { $regex: params.search, $options: 'i' } },
      ];
    }
    // Create Aggregation
    const aggregation = [];
    // Filters
    if (filters) {
      aggregation.push({
        $match: filters
      });
    }
    aggregation.push({
      $group: {
        _id: null,
        carMaker: {
          $addToSet: {
            carMaker: '$vehicleMake'
          }
        }
      }
    });
    aggregation.push({
      $unwind: {
        path: '$carMaker'
      }
    });
    aggregation.push({
      $replaceRoot: {
        newRoot: '$carMaker'
      }
    });
    aggregation.push({
      $sort: {
        carMaker: 1
      }
    });
    // Project
    DatabaseUtils.projectFields(aggregation, projectFields);
    // Execute
    const carMakersMDB = await global.database.getCollection<any>(Constants.DEFAULT_TENANT, 'carcatalogs')
      .aggregate(aggregation, {
        allowDiskUse: true
      })
      .toArray();
    // Debug
    await Logging.traceEnd(Constants.DEFAULT_TENANT, MODULE_NAME, 'getCarMakers', uniqueTimerID, carMakersMDB);
    return {
      count: carMakersMDB.length,
      result: carMakersMDB
    };
  }

  public static async saveCar(tenantID: string, carToSave: Car): Promise<string> {
    // Debug
    const uniqueTimerID = Logging.traceStart(tenantID, MODULE_NAME, 'saveCar');
    // Check Tenant
    await DatabaseUtils.checkTenant(tenantID);
    // Set
    const carMDB: any = {
      _id: carToSave.id ? Utils.convertToObjectID(carToSave.id) : new ObjectID(),
      vin: carToSave.vin,
      licensePlate: carToSave.licensePlate,
      carCatalogID: Utils.convertToInt(carToSave.carCatalogID),
      type: carToSave.type,
      converter: {
        powerWatts: Utils.convertToFloat(carToSave.converter.powerWatts),
        amperagePerPhase: Utils.convertToInt(carToSave.converter.amperagePerPhase),
        numberOfPhases: Utils.convertToFloat(carToSave.converter.numberOfPhases),
        type: carToSave.converter.type
      }
    };
    // Add Last Changed/Created props
    DatabaseUtils.addLastChangedCreatedProps(carMDB, carToSave);
    // Modify
    await global.database.getCollection<Car>(tenantID, 'cars').findOneAndUpdate(
      { _id: carMDB._id },
      { $set: carMDB },
      { upsert: true, returnDocument: 'after' }
    );
    // Debug
    await Logging.traceEnd(tenantID, MODULE_NAME, 'saveCar', uniqueTimerID, carMDB);
    return carMDB._id.toHexString();
  }

  public static async saveCarUser(tenantID: string, carUserToSave: UserCar): Promise<string> {
    // Debug
    const uniqueTimerID = Logging.traceStart(tenantID, MODULE_NAME, 'saveCarUser');
    // Check Tenant
    await DatabaseUtils.checkTenant(tenantID);
    // Set
    const carUserMDB: any = {
      _id: Cypher.hash(`${carUserToSave.carID}~${carUserToSave.user.id}`),
      userID: Utils.convertToObjectID(carUserToSave.user.id),
      carID: Utils.convertToObjectID(carUserToSave.carID),
      default: carUserToSave.default,
      owner: (carUserToSave.owner === true ? true : false)
    };
    // Add Last Changed/Created props
    DatabaseUtils.addLastChangedCreatedProps(carUserMDB, carUserToSave);
    // Modify
    await global.database.getCollection(tenantID, 'carusers').findOneAndUpdate(
      {
        _id: carUserMDB._id
      },

      { $set: carUserMDB },
      { upsert: true, returnDocument: 'after' }
    );
    // Debug
    await Logging.traceEnd(tenantID, MODULE_NAME, 'saveCarUser', uniqueTimerID, carUserMDB);
    return carUserMDB._id;
  }

  public static async insertCarUsers(tenantID: string, carUsersToSave: UserCar[]): Promise<void> {
    // Debug
    const uniqueTimerID = Logging.traceStart(tenantID, MODULE_NAME, 'insertCarUsers');
    // Check Tenant
    await DatabaseUtils.checkTenant(tenantID);
    // At least one user
    const carUsersMDB = [];
    if (carUsersToSave && carUsersToSave.length > 0) {
      // Set
      for (const carUserToSave of carUsersToSave) {
        const carUserMDB = {
          _id: Cypher.hash(`${carUserToSave.carID}~${carUserToSave.user.id}`),
          userID: Utils.convertToObjectID(carUserToSave.user.id),
          carID: Utils.convertToObjectID(carUserToSave.carID),
          default: carUserToSave.default,
          owner: carUserToSave.owner,
        };
        // Add Last Changed/Created props
        DatabaseUtils.addLastChangedCreatedProps(carUserMDB, carUserToSave);
        carUsersMDB.push(carUserMDB);
      }
      // Execute
      await global.database.getCollection<any>(tenantID, 'carusers').insertMany(
        carUsersMDB,
        { ordered: false }
      );
    }
    // Debug
    await Logging.traceEnd(tenantID, MODULE_NAME, 'insertCarUsers', uniqueTimerID, carUsersMDB);
  }

  public static async getCar(tenantID: string, id: string = Constants.UNKNOWN_STRING_ID,
      params: { withUsers?: boolean, userIDs?: string[]; type?: CarType } = {}, projectFields?: string[]): Promise<Car> {
    const carsMDB = await CarStorage.getCars(tenantID, {
      carIDs: [id],
      withUsers: params.withUsers,
      userIDs: params.userIDs,
      type: params.type
    }, Constants.DB_PARAMS_SINGLE_RECORD, projectFields);
    return carsMDB.count === 1 ? carsMDB.result[0] : null;
  }

  public static async getDefaultUserCar(tenantID: string, userID: string,
      params = {}, projectFields?: string[]): Promise<Car> {
    const carMDB = await CarStorage.getCars(tenantID, {
      userIDs: [userID],
      defaultCar: true,
    }, Constants.DB_PARAMS_SINGLE_RECORD, projectFields);
    return carMDB.count === 1 ? carMDB.result[0] : null;
  }

  public static async getFirstAvailableUserCar(tenantID: string, userID: string,
      params = {}, projectFields?: string[]): Promise<Car> {
    const carMDB = await CarStorage.getCars(tenantID, {
      userIDs: [userID],
    }, Constants.DB_PARAMS_SINGLE_RECORD, projectFields);
    return carMDB.count === 1 ? carMDB.result[0] : null;
  }

  public static async getCarByVinLicensePlate(tenantID: string,
      licensePlate: string = Constants.UNKNOWN_STRING_ID, vin: string = Constants.UNKNOWN_STRING_ID,
      params: { withUsers?: boolean, userIDs?: string[]; } = {}, projectFields?: string[]): Promise<Car> {
    const carsMDB = await CarStorage.getCars(tenantID, {
      licensePlate: licensePlate,
      vin: vin,
      withUsers: params.withUsers,
      userIDs: params.userIDs,
    }, Constants.DB_PARAMS_SINGLE_RECORD, projectFields);
    return carsMDB.count === 1 ? carsMDB.result[0] : null;
  }

  public static async getCars(tenantID: string,
      params: {
        search?: string; userIDs?: string[]; carIDs?: string[]; licensePlate?: string; vin?: string;
        withUsers?: boolean; defaultCar?: boolean; carMakers?: string[], type?: CarType;
      } = {},
      dbParams?: DbParams, projectFields?: string[]): Promise<DataResult<Car>> {
    // Debug
    const uniqueTimerID = Logging.traceStart(tenantID, MODULE_NAME, 'getCars');
    // Clone before updating the values
    dbParams = Utils.cloneObject(dbParams);
    // Check Limit
    dbParams.limit = Utils.checkRecordLimit(dbParams.limit);
    // Check Skip
    dbParams.skip = Utils.checkRecordSkip(dbParams.skip);
    // Create Aggregation
    const aggregation = [];
    // Set the filters
    const filters: FilterParams = {};
    // Search
    if (params.search) {
      filters.$or = [
        { 'vin': { $regex: params.search, $options: 'i' } },
        { 'licensePlate': { $regex: params.search, $options: 'i' } },
      ];
    }
    if (params.licensePlate) {
      filters.licensePlate = params.licensePlate;
    }
    if (params.vin) {
      filters.vin = params.vin;
    }
    if (params.type) {
      filters.type = params.type;
    }
    // Car
    if (!Utils.isEmptyArray(params.carIDs)) {
      filters._id = {
        $in: params.carIDs.map((carID) => Utils.convertToObjectID(carID))
      };
    }
    // Filter on Users
    if (!Utils.isEmptyArray(params.userIDs) || params.withUsers) {
      DatabaseUtils.pushUserCarLookupInAggregation({
        tenantID: tenantID, aggregation, localField: '_id', foreignField: 'carID',
        asField: 'carUsers', oneToOneCardinality: false
      });
      if (!Utils.isEmptyArray(params.userIDs)) {
        filters['carUsers.userID'] = { $in: params.userIDs.map((userID) => Utils.convertToObjectID(userID)) };
      }
      if (params.defaultCar) {
        filters['carUsers.default'] = true;
      }
    }
    // Add Car Catalog
    DatabaseUtils.pushCarCatalogLookupInAggregation({
      tenantID: Constants.DEFAULT_TENANT, aggregation, localField: 'carCatalogID', foreignField: '_id',
      asField: 'carCatalog', oneToOneCardinality: true
    });
    // Filter on car maker
    if (!Utils.isEmptyArray(params.carMakers)) {
      filters['carCatalog.vehicleMake'] = { $in: params.carMakers };
    }
    // Filters
    aggregation.push({
      $match: filters
    });
    // Limit records?
    if (!dbParams.onlyRecordCount) {
      // Always limit the nbr of record to avoid perfs issues
      aggregation.push({ $limit: Constants.DB_RECORD_COUNT_CEIL });
    }
    // Count Records
    const carsCountMDB = await global.database.getCollection<DataResult<Car>>(tenantID, 'cars')
      .aggregate([...aggregation, { $count: 'count' }], { allowDiskUse: true })
      .toArray();
    // Check if only the total count is requested
    if (dbParams.onlyRecordCount) {
      // Return only the count
      await Logging.traceEnd(tenantID, MODULE_NAME, 'getCars', uniqueTimerID, carsCountMDB);
      return {
        count: (carsCountMDB.length > 0 ? carsCountMDB[0].count : 0),
        result: []
      };
    }
    // Remove the limit
    aggregation.pop();
    // Sort
    if (!dbParams.sort) {
      dbParams.sort = {
        'carCatalog.vehicleMake': 1,
        'carCatalog.vehicleModel': 1,
        'carCatalog.vehicleModelVersion': 1,
        'licensePlate': 1,
      };
    }
    aggregation.push({
      $sort: dbParams.sort
    });
    // Skip
    if (dbParams.skip > 0) {
      aggregation.push({ $skip: dbParams.skip });
    }
    // Limit
    aggregation.push({
      $limit: (dbParams.limit > 0 && dbParams.limit < Constants.DB_RECORD_COUNT_CEIL) ? dbParams.limit : Constants.DB_RECORD_COUNT_CEIL
    });
    // Car Image
    aggregation.push({
      $addFields: {
        'carCatalog.image': {
          $cond: {
            if: { $gt: ['$carCatalog.image', null] }, then: {
              $concat: [
                `${Utils.buildRestServerURL()}/client/util/CarCatalogImage?ID=`,
                '$carCatalog.id',
                '&LastChangedOn=',
                { $toString: '$carCatalog.lastChangedOn' }
              ]
            }, else: null
          }

        }
      }
    });
    // Add Created By / Last Changed By
    DatabaseUtils.pushCreatedLastChangedInAggregation(tenantID, aggregation);
    // Handle the ID
    DatabaseUtils.pushRenameDatabaseID(aggregation);
    // Add Users
    if (params.withUsers) {
      // Check
      const carUsersPipeline = [];
      if (!Utils.isEmptyArray(params.userIDs)) {
        carUsersPipeline.push({
          $match: { 'carUsers.userID': { $in: params.userIDs.map((userID) => Utils.convertToObjectID(userID)) } }
        });
      }
      // User on Car Users
      DatabaseUtils.pushArrayLookupInAggregation('carUsers', DatabaseUtils.pushUserLookupInAggregation.bind(this), {
        tenantID, aggregation: aggregation, localField: 'carUsers.userID', foreignField: '_id',
        asField: 'carUsers.user', oneToOneCardinality: true, objectIDFields: ['createdBy', 'lastChangedBy']
      }, { pipeline: carUsersPipeline, sort: dbParams.sort });
    }
    // Project
    DatabaseUtils.projectFields(aggregation, projectFields);
    // Read DB
    const cars = await global.database.getCollection<Car>(tenantID, 'cars')
      .aggregate(aggregation, {
        allowDiskUse: true
      })
      .toArray();
    // Debug
    await Logging.traceEnd(tenantID, MODULE_NAME, 'getCars', uniqueTimerID, cars);
    return {
      count: (carsCountMDB.length > 0 ?
        (carsCountMDB[0].count === Constants.DB_RECORD_COUNT_CEIL ? -1 : carsCountMDB[0].count) : 0),
      result: cars
    };
  }

  public static async clearCarUserDefault(tenantID: string, userID: string): Promise<void> {
    const uniqueTimerID = Logging.traceStart(tenantID, MODULE_NAME, 'clearCarUserDefault');
    await DatabaseUtils.checkTenant(tenantID);
    await global.database.getCollection<any>(tenantID, 'carusers').updateMany(
      {
        userID: Utils.convertToObjectID(userID),
        default: true
      },
      {
        $set: { default: false }
      });
    await Logging.traceEnd(tenantID, MODULE_NAME, 'clearCarUserDefault', uniqueTimerID, { userID });
  }

  public static async clearCarUserOwner(tenantID: string, carID: string): Promise<void> {
    const uniqueTimerID = Logging.traceStart(tenantID, MODULE_NAME, 'clearCarUserOwner');
    await DatabaseUtils.checkTenant(tenantID);
    await global.database.getCollection<any>(tenantID, 'carusers').updateMany(
      {
        carID: Utils.convertToObjectID(carID),
        owner: true
      },
      {
        $set: { owner: false }
      });
    await Logging.traceEnd(tenantID, MODULE_NAME, 'clearCarUserOwner', uniqueTimerID, { carID });
  }

  public static async getCarUserByCarUser(tenantID: string,
      carID: string = Constants.UNKNOWN_STRING_ID, userID: string = Constants.UNKNOWN_STRING_ID,
      projectFields?: string[]): Promise<UserCar> {
    const carUsersMDB = await CarStorage.getCarUsers(tenantID, {
      carIDs: [carID],
      userIDs: [userID]
    }, Constants.DB_PARAMS_SINGLE_RECORD, projectFields);
    return carUsersMDB.count === 1 ? carUsersMDB.result[0] : null;
  }

  public static async getCarUser(tenantID: string, carUserID: string = Constants.UNKNOWN_STRING_ID,
      projectFields?: string[]): Promise<UserCar> {
    const carUsersMDB = await CarStorage.getCarUsers(tenantID, {
      carUsersIDs: [carUserID]
    }, Constants.DB_PARAMS_SINGLE_RECORD, projectFields);
    return carUsersMDB.count === 1 ? carUsersMDB.result[0] : null;
  }

  public static async deleteCarUser(tenantID: string, id: string): Promise<void> {
    // Debug
    const uniqueTimerID = Logging.traceStart(tenantID, MODULE_NAME, 'deleteCarUser');
    // Delete singular site area
    await global.database.getCollection(tenantID, 'carusers')
      .findOneAndDelete({ '_id': id });
    // Debug
    await Logging.traceEnd(tenantID, MODULE_NAME, 'deleteCarUser', uniqueTimerID, { id });
  }

  public static async deleteCarUsersByCarID(tenantID: string, carID: string): Promise<number> {
    // Debug
    const uniqueTimerID = Logging.traceStart(tenantID, MODULE_NAME, 'deleteCarUserByCarID');
    // Delete singular site area
    const result = await global.database.getCollection(tenantID, 'carusers')
      .deleteMany({ 'carID': Utils.convertToObjectID(carID) });
    // Debug
    await Logging.traceEnd(tenantID, MODULE_NAME, 'deleteCarUserByCarID', uniqueTimerID, { carID });
    return result.deletedCount;
  }

  public static async deleteCar(tenantID: string, carID: string): Promise<void> {
    // Debug
    const uniqueTimerID = Logging.traceStart(tenantID, MODULE_NAME, 'deleteCar');
    // Delete singular site area
    await global.database.getCollection(tenantID, 'cars')
      .deleteOne({ '_id': Utils.convertToObjectID(carID) });
    // Debug
    await Logging.traceEnd(tenantID, MODULE_NAME, 'deleteCar', uniqueTimerID, { carID });
  }

  public static async deleteCarUsers(tenantID: string, ids: string[]): Promise<void> {
    // Debug
    const uniqueTimerID = Logging.traceStart(tenantID, MODULE_NAME, 'deleteCarUserByCarID');
    // Delete singular site area
    await global.database.getCollection(tenantID, 'carusers')
      .deleteMany({ '_id': { $in: ids } });
    // Debug
    await Logging.traceEnd(tenantID, MODULE_NAME, 'deleteCarUserByCarID', uniqueTimerID, { ids });
  }

  public static async getCarUsers(tenantID: string,
      params: { search?: string; carUsersIDs?: string[]; userIDs?: string[]; carIDs?: string[]; } = {},
      dbParams?: DbParams, projectFields?: string[]): Promise<DataResult<UserCar>> {
    // Debug
    const uniqueTimerID = Logging.traceStart(tenantID, MODULE_NAME, 'getCarUsers');
    // Clone before updating the values
    dbParams = Utils.cloneObject(dbParams);
    // Check Limit
    dbParams.limit = Utils.checkRecordLimit(dbParams.limit);
    // Check Skip
    dbParams.skip = Utils.checkRecordSkip(dbParams.skip);
    // Set the filters
    const filters: FilterParams = {};
    // Limit on Car for Basic Users
    if (!Utils.isEmptyArray(params.carUsersIDs)) {
      filters._id = { $in: params.carUsersIDs };
    }
    // Cars
    if (!Utils.isEmptyArray(params.carIDs)) {
      filters.carID = { $in: params.carIDs.map((carID) => Utils.convertToObjectID(carID)) };
    }
    // Users
    if (!Utils.isEmptyArray(params.userIDs)) {
      filters.userID = { $in: params.userIDs.map((userID) => Utils.convertToObjectID(userID)) };
    }
    // Create Aggregation
    const aggregation = [];
    // Filters
    if (filters) {
      aggregation.push({
        $match: filters
      });
    }
    // Limit records?
    if (!dbParams.onlyRecordCount) {
      // Always limit the nbr of record to avoid perfs issues
      aggregation.push({ $limit: Constants.DB_RECORD_COUNT_CEIL });
    }
    // Count Records
    const carUsersCountMDB = await global.database.getCollection<DataResult<UserCar>>(tenantID, 'carusers')
      .aggregate([...aggregation, { $count: 'count' }], { allowDiskUse: true })
      .toArray();
    // Check if only the total count is requested
    if (dbParams.onlyRecordCount) {
      // Return only the count
      await Logging.traceEnd(tenantID, MODULE_NAME, 'getCarUsers', uniqueTimerID, carUsersCountMDB);
      return {
        count: (carUsersCountMDB.length > 0 ? carUsersCountMDB[0].count : 0),
        result: []
      };
    }
    // Remove the limit
    aggregation.pop();
    // Sort
    if (!dbParams.sort) {
      dbParams.sort = { 'user.name': 1, 'user.firstName': 1 };
    }
    aggregation.push({
      $sort: dbParams.sort
    });
    // Skip
    aggregation.push({
      $skip: dbParams.skip
    });
    // Limit
    aggregation.push({
      $limit: dbParams.limit
    });
    // Add User
    DatabaseUtils.pushUserLookupInAggregation({
      tenantID: tenantID, aggregation, localField: 'userID', foreignField: '_id',
      asField: 'user', oneToOneCardinality: true
    });
    // Convert Object ID to string
    DatabaseUtils.pushConvertObjectIDToString(aggregation, 'userID');
    // Add Created By / Last Changed By
    DatabaseUtils.pushCreatedLastChangedInAggregation(tenantID, aggregation);
    // Handle the ID
    DatabaseUtils.pushRenameDatabaseID(aggregation);
    // Project
    DatabaseUtils.projectFields(aggregation, projectFields);
    // Read DB
    const carUsers = await global.database.getCollection<UserCar>(tenantID, 'carusers')
      .aggregate(aggregation, {
        allowDiskUse: true
      })
      .toArray();
    // Debug
    await Logging.traceEnd(tenantID, MODULE_NAME, 'getCarUsers', uniqueTimerID, carUsers);
    return {
      count: (carUsersCountMDB.length > 0 ?
        (carUsersCountMDB[0].count === Constants.DB_RECORD_COUNT_CEIL ? -1 : carUsersCountMDB[0].count) : 0),
      result: carUsers
    };
  }
}
