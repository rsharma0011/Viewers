import { api } from 'dicomweb-client';
import DICOMWeb from '../../../DICOMWeb/';
import isLowPriorityModality from '../../../utils/isLowPriorityModality';

const INFO = Symbol('INFO');

const WADOProxy = {
  convertURL: (url, server) => {
    // TODO: Remove all WADOProxy stuff from this file
    return url;
  },
};

function parseFloatArray(obj) {
  const result = [];

  if (!obj) {
    return result;
  }

  const objs = obj.split('\\');
  for (let i = 0; i < objs.length; i++) {
    result.push(parseFloat(objs[i]));
  }

  return result;
}

/**
 * Simple cache schema for retrieved color palettes.
 */
const paletteColorCache = {
  count: 0,
  maxAge: 24 * 60 * 60 * 1000, // 24h cache?
  entries: {},
  isValidUID: function (paletteUID) {
    return typeof paletteUID === 'string' && paletteUID.length > 0;
  },
  get: function (paletteUID) {
    let entry = null;
    if (this.entries.hasOwnProperty(paletteUID)) {
      entry = this.entries[paletteUID];
      // check how the entry is...
      if (Date.now() - entry.time > this.maxAge) {
        // entry is too old... remove entry.
        delete this.entries[paletteUID];
        this.count--;
        entry = null;
      }
    }
    return entry;
  },
  add: function (entry) {
    if (this.isValidUID(entry.uid)) {
      let paletteUID = entry.uid;
      if (this.entries.hasOwnProperty(paletteUID) !== true) {
        this.count++; // increment cache entry count...
      }
      entry.time = Date.now();
      this.entries[paletteUID] = entry;
      // @TODO: Add logic to get rid of old entries and reduce memory usage...
    }
  },
};

/** Returns a WADO url for an instance
 *
 * @param studyInstanceUid
 * @param seriesInstanceUid
 * @param sopInstanceUid
 * @returns  {string}
 */
function buildInstanceWadoUrl(
  server,
  studyInstanceUid,
  seriesInstanceUid,
  sopInstanceUid
) {
  // TODO: This can be removed, since DICOMWebClient has the same function. Not urgent, though
  const params = [];

  params.push('requestType=WADO');
  params.push(`studyUID=${studyInstanceUid}`);
  params.push(`seriesUID=${seriesInstanceUid}`);
  params.push(`objectUID=${sopInstanceUid}`);
  params.push('contentType=application/dicom');
  params.push('transferSyntax=*');

  const paramString = params.join('&');

  return `${server.wadoUriRoot}?${paramString}`;
}

function buildInstanceWadoRsUri(
  server,
  studyInstanceUid,
  seriesInstanceUid,
  sopInstanceUid
) {
  return `${server.wadoRoot}/studies/${studyInstanceUid}/series/${seriesInstanceUid}/instances/${sopInstanceUid}`;
}

function buildInstanceFrameWadoRsUri(
  server,
  studyInstanceUid,
  seriesInstanceUid,
  sopInstanceUid,
  frame
) {
  const baseWadoRsUri = buildInstanceWadoRsUri(
    server,
    studyInstanceUid,
    seriesInstanceUid,
    sopInstanceUid
  );
  frame = frame != null || 1;

  return `${baseWadoRsUri}/frames/${frame}`;
}

/**
 * Parses the SourceImageSequence, if it exists, in order
 * to return a ReferenceSOPInstanceUID. The ReferenceSOPInstanceUID
 * is used to refer to this image in any accompanying DICOM-SR documents.
 *
 * @param instance
 * @returns {String} The ReferenceSOPInstanceUID
 */
function getSourceImageInstanceUid(instance) {
  // TODO= Parse the whole Source Image Sequence
  // This is a really poor workaround for now.
  // Later we should probably parse the whole sequence.
  var SourceImageSequence = instance['00082112'];
  if (
    SourceImageSequence &&
    SourceImageSequence.Value &&
    SourceImageSequence.Value.length &&
    SourceImageSequence.Value[0]['00081155'].Value
  ) {
    return SourceImageSequence.Value[0]['00081155'].Value[0];
  }
}

function getPaletteColor(server, instance, tag, lutDescriptor) {
  const numLutEntries = lutDescriptor[0];
  const bits = lutDescriptor[2];

  let uri = WADOProxy.convertURL(instance[tag].BulkDataURI, server);

  // TODO: Workaround for dcm4chee behind SSL-terminating proxy returning
  // incorrect bulk data URIs
  if (server.wadoRoot.indexOf('https') === 0 && !uri.includes('https')) {
    uri = uri.replace('http', 'https');
  }

  const config = {
    url: server.wadoRoot, //BulkDataURI is absolute, so this isn't used
    headers: DICOMWeb.getAuthorizationHeader(server),
  };
  const dicomWeb = new api.DICOMwebClient(config);
  const options = {
    BulkDataURI: uri,
  };

  const readUInt16 = (byteArray, position) => {
    return byteArray[position] + byteArray[position + 1] * 256;
  };

  const arrayBufferToPaletteColorLUT = result => {
    const arraybuffer = result[0];
    const byteArray = new Uint8Array(arraybuffer);
    const lut = [];

    for (let i = 0; i < numLutEntries; i++) {
      if (bits === 16) {
        lut[i] = readUInt16(byteArray, i * 2);
      } else {
        lut[i] = byteArray[i];
      }
    }

    return lut;
  };

  return dicomWeb.retrieveBulkData(options).then(arrayBufferToPaletteColorLUT);
}

/**
 * Fetch palette colors for instances with "PALETTE COLOR" photometricInterpretation.
 *
 * @param server {Object} Current server;
 * @param instance {Object} The retrieved instance metadata;
 * @returns {String} The ReferenceSOPInstanceUID
 */
async function getPaletteColors(server, instance, lutDescriptor) {
  let paletteUID = DICOMWeb.getString(instance['00281199']);

  return new Promise((resolve, reject) => {
    let entry;
    if (paletteColorCache.isValidUID(paletteUID)) {
      entry = paletteColorCache.get(paletteUID);

      if (entry) {
        return resolve(entry);
      }
    }

    // no entry in cache... Fetch remote data.
    const r = getPaletteColor(server, instance, '00281201', lutDescriptor);
    const g = getPaletteColor(server, instance, '00281202', lutDescriptor);
    const b = getPaletteColor(server, instance, '00281203', lutDescriptor);

    const promises = [r, g, b];

    Promise.all(promises).then(args => {
      entry = {
        red: args[0],
        green: args[1],
        blue: args[2],
      };

      // when paletteUID is present, the entry can be cached...
      entry.uid = paletteUID;
      paletteColorCache.add(entry);

      resolve(entry);
    });
  });
}

function getFrameIncrementPointer(element) {
  const frameIncrementPointerNames = {
    '00181065': 'frameTimeVector',
    '00181063': 'frameTime',
  };

  if (!element || !element.Value || !element.Value.length) {
    return;
  }

  const value = element.Value[0];
  return frameIncrementPointerNames[value];
}

function getRadiopharmaceuticalInfo(instance) {
  const modality = DICOMWeb.getString(instance['00080060']);

  if (modality !== 'PT') {
    return;
  }

  const radiopharmaceuticalInfo = instance['00540016'];
  if (
    radiopharmaceuticalInfo === undefined ||
    !radiopharmaceuticalInfo.Value ||
    !radiopharmaceuticalInfo.Value.length
  ) {
    return;
  }

  const firstPetRadiopharmaceuticalInfo = radiopharmaceuticalInfo.Value[0];
  return {
    radiopharmaceuticalStartTime: DICOMWeb.getString(
      firstPetRadiopharmaceuticalInfo['00181072']
    ),
    radionuclideTotalDose: DICOMWeb.getNumber(
      firstPetRadiopharmaceuticalInfo['00181074']
    ),
    radionuclideHalfLife: DICOMWeb.getNumber(
      firstPetRadiopharmaceuticalInfo['00181075']
    ),
  };
}

async function makeSOPInstance(server, study, instance) {
  const { studyInstanceUid } = study;
  const seriesInstanceUid = DICOMWeb.getString(instance['0020000E']);
  let series = study.seriesMap[seriesInstanceUid];

  if (!series) {
    series = {
      seriesInstanceUid,
      seriesDescription: DICOMWeb.getString(instance['0008103E']),
      modality: DICOMWeb.getString(instance['00080060']),
      seriesNumber: DICOMWeb.getNumber(instance['00200011']),
      seriesDate: DICOMWeb.getString(instance['00080021']),
      seriesTime: DICOMWeb.getString(instance['00080031']),
      instances: [],
    };
    study.seriesMap[seriesInstanceUid] = series;
    study.seriesList.push(series);
  }

  const sopInstanceUid = DICOMWeb.getString(instance['00080018']);
  const wadouri = buildInstanceWadoUrl(
    server,
    studyInstanceUid,
    seriesInstanceUid,
    sopInstanceUid
  );
  const baseWadoRsUri = buildInstanceWadoRsUri(
    server,
    studyInstanceUid,
    seriesInstanceUid,
    sopInstanceUid
  );
  const wadorsuri = buildInstanceFrameWadoRsUri(
    server,
    studyInstanceUid,
    seriesInstanceUid,
    sopInstanceUid
  );

  const sopInstance = {
    imageType: DICOMWeb.getString(instance['00080008']),
    sopClassUid: DICOMWeb.getString(instance['00080016']),
    modality: DICOMWeb.getString(instance['00080060']),
    sopInstanceUid,
    instanceNumber: DICOMWeb.getNumber(instance['00200013']),
    imagePositionPatient: DICOMWeb.getString(instance['00200032']),
    imageOrientationPatient: DICOMWeb.getString(instance['00200037']),
    frameOfReferenceUID: DICOMWeb.getString(instance['00200052']),
    sliceLocation: DICOMWeb.getNumber(instance['00201041']),
    samplesPerPixel: DICOMWeb.getNumber(instance['00280002']),
    photometricInterpretation: DICOMWeb.getString(instance['00280004']),
    planarConfiguration: DICOMWeb.getNumber(instance['00280006']),
    rows: DICOMWeb.getNumber(instance['00280010']),
    columns: DICOMWeb.getNumber(instance['00280011']),
    pixelSpacing: DICOMWeb.getString(instance['00280030']),
    pixelAspectRatio: DICOMWeb.getString(instance['00280034']),
    bitsAllocated: DICOMWeb.getNumber(instance['00280100']),
    bitsStored: DICOMWeb.getNumber(instance['00280101']),
    highBit: DICOMWeb.getNumber(instance['00280102']),
    pixelRepresentation: DICOMWeb.getNumber(instance['00280103']),
    smallestPixelValue: DICOMWeb.getNumber(instance['00280106']),
    largestPixelValue: DICOMWeb.getNumber(instance['00280107']),
    windowCenter: DICOMWeb.getString(instance['00281050']),
    windowWidth: DICOMWeb.getString(instance['00281051']),
    rescaleIntercept: DICOMWeb.getNumber(instance['00281052']),
    rescaleSlope: DICOMWeb.getNumber(instance['00281053']),
    rescaleType: DICOMWeb.getNumber(instance['00281054']),
    sourceImageInstanceUid: getSourceImageInstanceUid(instance),
    laterality: DICOMWeb.getString(instance['00200062']),
    viewPosition: DICOMWeb.getString(instance['00185101']),
    acquisitionDateTime: DICOMWeb.getString(instance['0008002A']),
    numberOfFrames: DICOMWeb.getNumber(instance['00280008']),
    frameIncrementPointer: getFrameIncrementPointer(instance['00280009']),
    frameTime: DICOMWeb.getNumber(instance['00181063']),
    frameTimeVector: parseFloatArray(DICOMWeb.getString(instance['00181065'])),
    sliceThickness: DICOMWeb.getNumber(instance['00180050']),
    spacingBetweenSlices: DICOMWeb.getString(instance['00180088']),
    lossyImageCompression: DICOMWeb.getString(instance['00282110']),
    derivationDescription: DICOMWeb.getString(instance['00282111']),
    lossyImageCompressionRatio: DICOMWeb.getString(instance['00282112']),
    lossyImageCompressionMethod: DICOMWeb.getString(instance['00282114']),
    echoNumber: DICOMWeb.getString(instance['00180086']),
    contrastBolusAgent: DICOMWeb.getString(instance['00180010']),
    radiopharmaceuticalInfo: getRadiopharmaceuticalInfo(instance),
    baseWadoRsUri: baseWadoRsUri,
    wadouri: WADOProxy.convertURL(wadouri, server),
    wadorsuri: WADOProxy.convertURL(wadorsuri, server),
    wadoRoot: server.wadoRoot,
    imageRendering: server.imageRendering,
    thumbnailRendering: server.thumbnailRendering,
  };

  // Get additional information if the instance uses "PALETTE COLOR" photometric interpretation
  if (sopInstance.photometricInterpretation === 'PALETTE COLOR') {
    const redPaletteColorLookupTableDescriptor = parseFloatArray(
      DICOMWeb.getString(instance['00281101'])
    );
    const greenPaletteColorLookupTableDescriptor = parseFloatArray(
      DICOMWeb.getString(instance['00281102'])
    );
    const bluePaletteColorLookupTableDescriptor = parseFloatArray(
      DICOMWeb.getString(instance['00281103'])
    );
    const palettes = await getPaletteColors(
      server,
      instance,
      redPaletteColorLookupTableDescriptor
    );

    if (palettes) {
      if (palettes.uid) {
        sopInstance.paletteColorLookupTableUID = palettes.uid;
      }

      sopInstance.redPaletteColorLookupTableData = palettes.red;
      sopInstance.greenPaletteColorLookupTableData = palettes.green;
      sopInstance.bluePaletteColorLookupTableData = palettes.blue;
      sopInstance.redPaletteColorLookupTableDescriptor = redPaletteColorLookupTableDescriptor;
      sopInstance.greenPaletteColorLookupTableDescriptor = greenPaletteColorLookupTableDescriptor;
      sopInstance.bluePaletteColorLookupTableDescriptor = bluePaletteColorLookupTableDescriptor;
    }
  }

  series.instances.push(sopInstance);
  return sopInstance;
}

/**
 * Create a plain JS object that describes a study (a study descriptor object)
 * @param {Object} server Object with server configuration paramenters
 * @param {Object} aSopInstance a SOP Instance from which study information will be added
 */
function createStudy(server, aSopInstance) {
  // TODO: Pass a reference ID to the server instead of including the URLs here
  return {
    seriesList: [],
    seriesMap: Object.create(null),
    seriesLoader: null,
    wadoUriRoot: server.wadoUriRoot,
    wadoRoot: server.wadoRoot,
    qidoRoot: server.qidoRoot,
    patientName: DICOMWeb.getName(aSopInstance['00100010']),
    patientId: DICOMWeb.getString(aSopInstance['00100020']),
    patientAge: DICOMWeb.getNumber(aSopInstance['00101010']),
    patientSize: DICOMWeb.getNumber(aSopInstance['00101020']),
    patientWeight: DICOMWeb.getNumber(aSopInstance['00101030']),
    accessionNumber: DICOMWeb.getString(aSopInstance['00080050']),
    studyDate: DICOMWeb.getString(aSopInstance['00080020']),
    modalities: DICOMWeb.getString(aSopInstance['00080061']),
    studyDescription: DICOMWeb.getString(aSopInstance['00081030']),
    imageCount: DICOMWeb.getString(aSopInstance['00201208']),
    studyInstanceUid: DICOMWeb.getString(aSopInstance['0020000D']),
    institutionName: DICOMWeb.getString(aSopInstance['00080080']),
  };
}

/**
 * Add a list of SOP Instances to a given study object descriptor
 * @param {Object} server Object with server configuration paramenters
 * @param {Object} study The study descriptor to which the given SOP instances will be added
 * @param {Array} sopInstanceList A list of SOP instance objects
 */
async function addInstancesToStudy(server, study, sopInstanceList) {
  return Promise.all(
    sopInstanceList.map(function (sopInstance) {
      return makeSOPInstance(server, study, sopInstance);
    })
  );
}

/**
 * Parses result data from a WADO search into Study MetaData
 * Returns an object populated with study metadata, including the
 * series list.
 *
 * @param {Object} server Object with server configuration paramenters
 * @param {Array} sopInstanceList List of SOP Instances that build up to the study
 * @resolves {{seriesList: Array, patientName: *, patientId: *, accessionNumber: *, studyDate: *, modalities: *, studyDescription: *, imageCount: *, studyInstanceUid: *}}
 */
async function createStudyFromSOPInstanceList(server, sopInstanceList) {
  if (Array.isArray(sopInstanceList) && sopInstanceList.length > 0) {
    const firstSopInstance = sopInstanceList[0];
    const study = createStudy(server, firstSopInstance);
    await addInstancesToStudy(server, study, sopInstanceList);
    return study;
  }
  throw new Error('Failed to create study out of provided SOP instance list');
}

/**
 * Retrieve Study metadata from a DICOM server. If the server is configured to use lazy load, only the first series
 * will be loaded and the property "studyLoader" will be set to let consumer load remaining series as needed
 * @param {Object} server Object with server configuration paramenters
 * @param {string} studyInstanceUid The Study Instance UID of the study which needs to be loaded
 * @returns {Object} A study descriptor object
 */
async function RetrieveMetadata(server, studyInstanceUid, filters) {
  return (server.enableStudyLazyLoad !== false && false
    ? lazyLoadStudyMetadata
    : loadStudyMetadata)(server, studyInstanceUid, filters);
}

/**
 *
 * @param {*} server
 * @param {*} studyInstanceUID
 */
async function loadStudyMetadata(server, studyInstanceUID, filters) {
  const client = new api.DICOMwebClient({
    url: server.wadoRoot,
    headers: DICOMWeb.getAuthorizationHeader(server),
  });

  const options = {
    studyInstanceUID,
  };

  const { seriesInstanceUID } = filters;

  let retrieveMethod = client.retrieveStudyMetadata;

  if (seriesInstanceUID) {
    retrieveMethod = client.retrieveSeriesMetadata;
    options['seriesInstanceUID'] = seriesInstanceUID;
  }

  let studyMetadata;

  try {
    studyMetadata = await retrieveMethod.call(client, options);
  } catch (e) {
    // in case occurred error when retrieveSeriesMetadata, retrieve again from retrieveStudyMetadata
    if (seriesInstanceUID) {
      studyMetadata = await client.retrieveStudyMetadata({ studyInstanceUID });
    } else {
      throw e;
    }
  }

  const study = await createStudyFromSOPInstanceList(server, studyMetadata);

  return study;
}

async function lazyLoadStudyMetadata(server, studyInstanceUID, filters) {
  const seriesInstanceUIDs = await searchStudySeries(server, studyInstanceUID);
  const filtered = filterStudySeries(seriesInstanceUIDs, filters);
  const toSort = filtered && filtered.length ? filtered : seriesInstanceUIDs;
  const sorted = sortStudySeries(toSort);
  const seriesInstanceUIDsMap = mapStudySeries(sorted);

  const dicomWeb = new api.DICOMwebClient({
    url: server.wadoRoot,
    headers: DICOMWeb.getAuthorizationHeader(server),
  });

  const seriesLoader = makeSeriesLoader(
    dicomWeb,
    studyInstanceUID,
    seriesInstanceUIDsMap
  );
  const firstSeries = await seriesLoader.next();
  const study = await createStudyFromSOPInstanceList(
    server,
    firstSeries.sopInstances
  );
  if (seriesLoader.hasNext()) {
    attachSeriesLoader(server, study, seriesLoader);
  }
  return study;
}

function attachSeriesLoader(server, study, seriesLoader) {
  study.seriesLoader = Object.freeze({
    hasNext() {
      return seriesLoader.hasNext();
    },
    async next() {
      const series = await seriesLoader.next();
      await addInstancesToStudy(server, study, series.sopInstances);
      return study.seriesMap[series.seriesInstanceUID];
    },
  });
}

/**
 * Creates an immutable series loader object which loads each series sequentially using the iterator interface
 * @param {DICOMWebClient} dicomWebClient The DICOMWebClient instance to be used for series load
 * @param {string} studyInstanceUID The Study Instance UID from which series will be loaded
 * @param {Array} seriesInstanceUIDList A list of Series Instance UIDs
 * @returns {Object} Returns an object which supports loading of instances from each of given Series Instance UID
 */
function makeSeriesLoader(
  dicomWebClient,
  studyInstanceUID,
  seriesInstanceUIDList
) {
  return Object.freeze({
    hasNext() {
      return seriesInstanceUIDList.length > 0;
    },
    async next() {
      const seriesInstanceUID = seriesInstanceUIDList.shift();
      const sopInstances = await dicomWebClient.retrieveSeriesMetadata({
        studyInstanceUID,
        seriesInstanceUID,
      });
      return { studyInstanceUID, seriesInstanceUID, sopInstances };
    },
  });
}

/**
 * Search series of a given study
 * @param {Object} server Object with server configuration paramenters
 * @param {string} studyInstanceUID The Study Instance UID to search series from;
 * @returns {Arrays} A list of Series Instances
 */
async function searchStudySeries(server, studyInstanceUID) {
  const dicomWeb = new api.DICOMwebClient({
    url: server.qidoRoot,
    headers: DICOMWeb.getAuthorizationHeader(server),
  });
  const seriesList = await dicomWeb.searchForSeries({ studyInstanceUID });
  return seriesList;
}

/**
 * Sort seriesList
 * @param {Arrays} seriesList list of Series Instance UIDs
 * @returns {Arrays} A list of Series Instances
 */
function sortStudySeries(seriesList) {
  return seriesList.sort(seriesSortingCriteria);
}

/**
 * Filter seriesList
 * @param {Arrays} seriesList list of Series Instance UIDs
 * @param {Object} filters object containing filter to be applied.
 * @returns {Arrays} A list of Series Instances
 */
function filterStudySeries(seriesList, filters) {
  let result = [...seriesList];
  const { seriesInstanceUID: toCompare } = filters;

  const compare = (valueToCompare, series) => {
    const seriesInstanceUID = DICOMWeb.getString(series['0020000E']);
    return valueToCompare === seriesInstanceUID;
  };

  if (toCompare) {
    result = result.filter(series => compare(toCompare, series));
  }

  return result;
}
/**
 * Map seriesList to an array of seriesInstanceUid
 * @param {Arrays} seriesList list of Series Instance UIDs
 * @returns {Arrays} A list of Series Instance UIDs
 */
function mapStudySeries(seriesList) {
  return seriesList.map(series => getSeriesInfo(series).seriesInstanceUid);
}

/**
 * Series sorting criteria: series considered low priority are moved to the end
 * of the list and series number is used to break ties
 * @param {Object} firstSeries
 * @param {Object} secondSeries
 */
function seriesSortingCriteria(firstSeries, secondSeries) {
  const a = getSeriesInfo(firstSeries);
  const b = getSeriesInfo(secondSeries);
  if (!a.isLowPriority && b.isLowPriority) {
    return -1;
  }
  if (a.isLowPriority && !b.isLowPriority) {
    return 1;
  }
  return a.seriesNumber - b.seriesNumber;
}

/**
 * Creates an object with processed series information and saves its reference
 * inside the series object itself to simplify sorting
 * @param {Object} series The raw series object
 */
function getSeriesInfo(series) {
  let info = series[INFO];
  if (!info) {
    const modality = DICOMWeb.getString(series['00080060'], '').toUpperCase();
    info = Object.freeze({
      modality,
      isLowPriority: isLowPriorityModality(modality),
      seriesInstanceUid: DICOMWeb.getString(series['0020000E']),
      seriesNumber: DICOMWeb.getNumber(series['00200011'], 0) || 0,
    });
    series[INFO] = info;
  }
  return info;
}

export default RetrieveMetadata;
