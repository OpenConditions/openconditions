import type { PinnedSet } from "../pinned.js";

/**
 * DATEX II v3.7: the full per-namespace schemas from
 * https://docs.datex2.eu/downloads/modelv37/ (served under `MODEL_BASE`), and
 * the Exchange 2020.1 `cisxsd.zip` from
 * https://docs.datex2.eu/exchange-2020/downloads/ (`messageContainer` and the
 * namespaces it imports). Retrieved 2026-10-15. datex2.eu and docs.datex2.eu
 * publish them without any licence or redistribution terms (only "Copyright ©
 * DATEX II"), so they are fetched, not vendored.
 */
const MODEL_BASE = "https://docs.datex2.eu/_static/data/v3.7/";

export const DATEX2_V3: PinnedSet = {
  id: "datex2-v3.7",
  files: [
    {
      name: "DATEXII_3_AfirEnergyInfrastructure.xsd",
      url: `${MODEL_BASE}DATEXII_3_AfirEnergyInfrastructure.xsd`,
      sha256: "c5439e004e652d26ff3a16965e8f9bf5d4dacf38f13f2f9b965aa78236385ba4",
    },
    {
      name: "DATEXII_3_AfirFacilities.xsd",
      url: `${MODEL_BASE}DATEXII_3_AfirFacilities.xsd`,
      sha256: "63a7f8059b440714d8216f77431bed7f3d8c362bdfba70621c1c564e47b9e3ee",
    },
    {
      name: "DATEXII_3_Common.xsd",
      url: `${MODEL_BASE}DATEXII_3_Common.xsd`,
      sha256: "56a0b3eb3e12e731079339c1c39dbde250eb01de9604af0a49ae1004f7d76099",
    },
    {
      name: "DATEXII_3_CommonExtension.xsd",
      url: `${MODEL_BASE}DATEXII_3_CommonExtension.xsd`,
      sha256: "7e7d5ff0b16d346935e880bacfc5b68df5e262b0a63ba2722e1b1fb122e8859d",
    },
    {
      name: "DATEXII_3_ControlledZone.xsd",
      url: `${MODEL_BASE}DATEXII_3_ControlledZone.xsd`,
      sha256: "8d7eb06a61c1f822ff9c9e7195ad4e28f339b3f1f419799a22bde4f8412f1045",
    },
    {
      name: "DATEXII_3_D2Payload.xsd",
      url: `${MODEL_BASE}DATEXII_3_D2Payload.xsd`,
      sha256: "ee68479cb7c3bc9bbf3eff6b76d9abf8766eb0160c70e6fb96688895342f6cb4",
    },
    {
      name: "DATEXII_3_EnergyInfrastructure.xsd",
      url: `${MODEL_BASE}DATEXII_3_EnergyInfrastructure.xsd`,
      sha256: "7fb51e068964564afc71807474f1c7307dda2c85881e1b683682116c19cb35a1",
    },
    {
      name: "DATEXII_3_Facilities.xsd",
      url: `${MODEL_BASE}DATEXII_3_Facilities.xsd`,
      sha256: "6f2f5500c820e1089f797ccb7ca2c5a9fae678f3239c4310a20efa91649559c3",
    },
    {
      name: "DATEXII_3_FaultAndStatus.xsd",
      url: `${MODEL_BASE}DATEXII_3_FaultAndStatus.xsd`,
      sha256: "b2a8b642f4e80b157763172884e1de59fbb64a53c2d1de9e59f017677496e10d",
    },
    {
      name: "DATEXII_3_LocationExtension.xsd",
      url: `${MODEL_BASE}DATEXII_3_LocationExtension.xsd`,
      sha256: "741b0efc946b559ef97110a7dbbf6ac20590a375a271f39174228af23c437c21",
    },
    {
      name: "DATEXII_3_LocationReferencing.xsd",
      url: `${MODEL_BASE}DATEXII_3_LocationReferencing.xsd`,
      sha256: "4d647ce166abed4d0046f6a723e1503176476dc9db7e824b4cbb07035d80e784",
    },
    {
      name: "DATEXII_3_Parking.xsd",
      url: `${MODEL_BASE}DATEXII_3_Parking.xsd`,
      sha256: "468139279a5304de2e03e24b412738ce074fbc35c94261898dad00b48091ac74",
    },
    {
      name: "DATEXII_3_ReroutingManagementEnhanced.xsd",
      url: `${MODEL_BASE}DATEXII_3_ReroutingManagementEnhanced.xsd`,
      sha256: "cdc90c71ce6dda9cb125c404f12a31e98ce92678a3eea662deb2d51485b9b056",
    },
    {
      name: "DATEXII_3_RoadTrafficData.xsd",
      url: `${MODEL_BASE}DATEXII_3_RoadTrafficData.xsd`,
      sha256: "54240256240107e4f0cd67718139a7c555ff753e297f6a8502756d14a57d9191",
    },
    {
      name: "DATEXII_3_Situation.xsd",
      url: `${MODEL_BASE}DATEXII_3_Situation.xsd`,
      sha256: "bd4d95d9ac0dcf86e31478af3e239a4c4a3502f70435c6e7f058c79c6c861ed4",
    },
    {
      name: "DATEXII_3_TrafficManagementPlan.xsd",
      url: `${MODEL_BASE}DATEXII_3_TrafficManagementPlan.xsd`,
      sha256: "13921c1ba03958e3a33fabebb76f0fdf0840624382782f16d17d7707547bee96",
    },
    {
      name: "DATEXII_3_TrafficRegulation.xsd",
      url: `${MODEL_BASE}DATEXII_3_TrafficRegulation.xsd`,
      sha256: "47a7bbab15ecacb18a47cea60d16a793832c74d3bb5c5e507675dbbb257738f9",
    },
    {
      name: "DATEXII_3_UrbanExtensions.xsd",
      url: `${MODEL_BASE}DATEXII_3_UrbanExtensions.xsd`,
      sha256: "392b65a86bfbb5a916df95e135aeddc6eb9f9196bae66a5ca5e22339781d2e7c",
    },
    {
      name: "DATEXII_3_Vms.xsd",
      url: `${MODEL_BASE}DATEXII_3_Vms.xsd`,
      sha256: "46cf6bbc255b07d22e4973d64b9e45bc69640615cfbba96c96dc6ada14af9f2b",
    },
  ],
  archives: [
    {
      url: "https://docs.datex2.eu/_static/data/exchange/2020.1/cisxsd.zip",
      members: {
        "DATEXII_3_CISInformation.xsd":
          "12fc09298b4bc617d7d49cbc727ecf5ec319539c514da817705da8bc9d342923",
        "DATEXII_3_ExchangeInformation.xsd":
          "a1a5a43b05513bcfbe60ab2662cabe8fb5a61f5822ee6b21e802a074fc410983",
        "DATEXII_3_InformationManagement.xsd":
          "86057b30664e04323de502d07f26a77b8c097b366705e9aea088dad777fe4086",
        "DATEXII_3_MessageContainer.xsd":
          "c97062370eb9d169c9e565d0c59ce86e435ef50558db2ea0f1216cdacf7ebc87",
      },
    },
  ],
};

/** The root schema of a `messageContainer` document. */
export const MESSAGE_CONTAINER_SCHEMA = "DATEXII_3_MessageContainer.xsd";

/** The root schema of a bare `payload` document, the D2Payload namespace. */
export const PAYLOAD_SCHEMA = "DATEXII_3_D2Payload.xsd";
