require("dotenv").config();
const { initializeApp } = require("firebase/app");
const { getFirestore, doc, getDoc, setDoc } = require("firebase/firestore");
const fetch = (...args) =>
  import("node-fetch").then(({ default: fetch }) => fetch(...args));

// ======================
// Configuración Firebase
// ======================
const firebaseConfig = {
  apiKey: process.env.FIREBASE_API_KEY,
  authDomain: process.env.FIREBASE_AUTH_DOMAIN,
  projectId: process.env.FIREBASE_PROJECT_ID,
  storageBucket: process.env.FIREBASE_STORAGE_BUCKET,
  messagingSenderId: process.env.FIREBASE_SENDER_ID,
  appId: process.env.FIREBASE_APP_ID,
};

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);

// =======================
// Variables de entorno
// =======================
const PLAYER_NAME = process.env.PLAYER_NAME;
const TELEGRAM_BOT_TOKEN = process.env.BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.CHAT_ID;

if (!PLAYER_NAME || !TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
  throw new Error("Faltan variables de entorno requeridas");
}

// =======================
// Constantes y Helpers
// =======================
const MAX_RETRIES = 3;
const INITIAL_RETRY_DELAY = 1000; // 1 segundo
const COLLECTION_NAME = "skyblock_tracker";

/**
 * Función para realizar fetch con reintentos y backoff exponencial.
 */
async function fetchWithRetry(url, options = {}, retries = MAX_RETRIES) {
  let delay = INITIAL_RETRY_DELAY;
  for (let i = 0; i < retries; i++) {
    try {
      const response = await fetch(url, options);
      if (!response.ok) throw new Error(`HTTP error: ${response.status}`);
      return response;
    } catch (error) {
      console.warn(
        `Error en fetch (intento ${i + 1}/${retries}): ${error.message}`
      );
      if (i === retries - 1) throw error;
      await new Promise((resolve) => setTimeout(resolve, delay));
      delay *= 2;
    }
  }
}

/**
 * Envía un mensaje a Telegram para notificar errores o actualizaciones.
 */
async function sendTelegramMessage(message) {
  try {
    const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
    const response = await fetchWithRetry(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        text: message,
        parse_mode: "Markdown",
      }),
    });
    return await response.json();
  } catch (error) {
    console.error("Error enviando mensaje a Telegram:", error);
  }
}

/**
 * Funciones para interactuar con Firestore.
 */
async function getFirebaseData(documentName) {
  const docRef = doc(db, COLLECTION_NAME, documentName);
  const snapshot = await getDoc(docRef);
  return snapshot.exists() ? snapshot.data() : {};
}

async function updateFirebaseData(documentName, data) {
  const docRef = doc(db, COLLECTION_NAME, documentName);
  await setDoc(docRef, data);
}

// =======================
// Funciones para procesar el inventario
// =======================
function processContainer(container) {
  const itemsMap = new Map();
  for (const item of Object.values(container)) {
    if (!item?.id) continue;
    const key = item.display_name || "Sin nombre";
    const count = item.Count || 1;
    itemsMap.set(key, (itemsMap.get(key) || 0) + count);
  }
  return Object.fromEntries(itemsMap);
}

function processStorage(storage) {
  const itemsMap = new Map();
  for (const unit of Object.values(storage)) {
    if (!unit?.containsItems) continue;
    for (const item of Object.values(unit.containsItems)) {
      if (!item?.id) continue;
      const key = item.display_name || "Sin nombre";
      const count = item.Count || 1;
      itemsMap.set(key, (itemsMap.get(key) || 0) + count);
    }
  }
  return Object.fromEntries(itemsMap);
}

/**
 * Obtiene el inventario del jugador desde la API.
 */
async function getPlayerInventory() {
  try {
    const url = `https://sky.shiiyu.moe/api/v2/profile/${PLAYER_NAME}`;
    const response = await fetchWithRetry(url);
    const data = await response.json();

    if (!data.profiles || typeof data.profiles !== "object") {
      throw new Error("Respuesta inválida de la API");
    }

    const currentProfile = Object.values(data.profiles).find(
      (profile) => profile.current === true
    );
    if (!currentProfile?.data?.items) {
      throw new Error("Datos del perfil no encontrados");
    }

    return {
      inventory: processContainer(currentProfile.data.items.inventory),
      enderchest: processContainer(currentProfile.data.items.enderchest),
      storage: processStorage(currentProfile.data.items.storage),
    };
  } catch (error) {
    console.error("Error obteniendo inventario:", error);
    await sendTelegramMessage(
      `🚨 Error obteniendo inventario: ${error.message}`
    );
    return null;
  }
}

/**
 * Compara el inventario actual con el almacenado en Firebase y actualiza los registros.
 */
async function checkInventoryChanges() {
  try {
    const inventoryData = await getPlayerInventory();
    if (!inventoryData) return;

    const currentInventory = {
      ...inventoryData.inventory,
      ...inventoryData.enderchest,
      ...inventoryData.storage,
    };

    const [prevInventory, investmentRecord] = await Promise.all([
      getFirebaseData("prev_inventory"),
      getFirebaseData("investment_record"),
    ]);

    let hasChanges = false;
    const newInvestmentRecord = { ...investmentRecord };

    // Procesar cambios: inversiones y ventas
    for (const [itemName, currentCount] of Object.entries(currentInventory)) {
      const prevCount = prevInventory[itemName] || 0;
      const diff = currentCount - prevCount;

      if (diff > 0) {
        newInvestmentRecord[itemName] =
          (newInvestmentRecord[itemName] || 0) + diff;
        hasChanges = true;
      } else if (diff < 0) {
        const invested = newInvestmentRecord[itemName] || 0;
        const sold = Math.min(Math.abs(diff), invested);
        if (sold > 0) {
          newInvestmentRecord[itemName] -= sold;
          hasChanges = true;
        }
      }
    }

    // Eliminar items que ya no existen
    for (const itemName in newInvestmentRecord) {
      if (
        !(itemName in currentInventory) &&
        newInvestmentRecord[itemName] > 0
      ) {
        delete newInvestmentRecord[itemName];
        hasChanges = true;
      }
    }

    if (hasChanges) {
      let message = `📊 Actualización de ${PLAYER_NAME}:\n`;
      const changes = Object.entries(currentInventory)
        .filter(([name, count]) => (prevInventory[name] || 0) !== count)
        .map(
          ([name, count]) => `${name}: ${prevInventory[name] || 0} → ${count}`
        );
      if (changes.length > 0) {
        message += "\n🔔 Cambios:\n" + changes.join("\n");
      }
      await sendTelegramMessage(message);
    }

    // Actualizar datos en Firebase
    await Promise.all([
      updateFirebaseData("prev_inventory", currentInventory),
      updateFirebaseData("investment_record", newInvestmentRecord),
    ]);
  } catch (error) {
    console.error("Error en checkInventoryChanges:", error);
    await sendTelegramMessage(
      `🚨 Error en checkInventoryChanges: ${error.message}`
    );
    throw error;
  }
}

// =======================
// Ejecución principal
// =======================
(async () => {
  try {
    await checkInventoryChanges();
    console.log("Ejecución completada exitosamente");
  } catch (error) {
    console.error("Error en la ejecución principal:", error);
    await sendTelegramMessage(`🚨 Error crítico: ${error.message}`);
    process.exit(1);
  }
})();

// =======================
// Manejo global de errores
// =======================
process.on("uncaughtException", async (error) => {
  console.error("uncaughtException:", error);
  await sendTelegramMessage(`💥 Error no capturado: ${error.message}`);
  process.exit(1);
});

process.on("unhandledRejection", async (reason, promise) => {
  console.error("unhandledRejection:", reason);
  await sendTelegramMessage(`⚠️ Promesa rechazada: ${reason}`);
  process.exit(1);
});
