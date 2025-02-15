require("dotenv").config();
const { initializeApp } = require("firebase/app");
const { getFirestore, doc, getDoc, setDoc } = require("firebase/firestore");
const fetch = (...args) => import("node-fetch").then(({ default: fetch }) => fetch(...args));

// ======================
// Configuración inicial
// ======================
const FIREBASE_CONFIG = {
  apiKey: process.env.FIREBASE_API_KEY,
  authDomain: process.env.FIREBASE_AUTH_DOMAIN,
  projectId: process.env.FIREBASE_PROJECT_ID,
  storageBucket: process.env.FIREBASE_STORAGE_BUCKET,
  messagingSenderId: process.env.FIREBASE_SENDER_ID,
  appId: process.env.FIREBASE_APP_ID
};

const TELEGRAM_CONFIG = {
  botToken: process.env.BOT_TOKEN,
  chatId: process.env.CHAT_ID
};

const PLAYER_NAME = process.env.PLAYER_NAME;
const MAX_RETRIES = 3;
const COLLECTION_NAME = "skyblock_tracker";

// ======================
// Validación inicial
// ======================
function validateEnvironment() {
  const missingVars = [];
  if (!PLAYER_NAME) missingVars.push("PLAYER_NAME");
  if (!TELEGRAM_CONFIG.botToken) missingVars.push("BOT_TOKEN");
  if (!TELEGRAM_CONFIG.chatId) missingVars.push("CHAT_ID");
  if (!Object.values(FIREBASE_CONFIG).every(Boolean)) missingVars.push("Variables de Firebase");

  if (missingVars.length > 0) {
    throw new Error(`Variables faltantes: ${missingVars.join(", ")}`);
  }
}

// ======================
// Helpers de Firebase
// ======================
async function firebaseOperation(operation, ...args) {
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await operation(...args);
    } catch (error) {
      console.error(`Intento ${attempt} fallido:`, error.message);
      if (attempt === MAX_RETRIES) throw error;
      await new Promise(resolve => setTimeout(resolve, 2000 * attempt));
    }
  }
}

async function getFirebaseData(documentName) {
  return firebaseOperation(async () => {
    const docRef = doc(getFirestore(), COLLECTION_NAME, documentName);
    const snapshot = await getDoc(docRef);
    return snapshot.exists() ? snapshot.data() : {};
  });
}

async function updateFirebaseData(documentName, data) {
  return firebaseOperation(async () => {
    const docRef = doc(getFirestore(), COLLECTION_NAME, documentName);
    await setDoc(docRef, data);
  });
}

// ======================
// Helpers de Telegram
// ======================
async function sendTelegramAlert(message, error = null) {
  const maxMessageLength = 4000;
  let errorDetails = "";

  if (error) {
    errorDetails = `\n\n🚨 Error Details:\n${error.stack || error.message}`;
    errorDetails = errorDetails.slice(0, maxMessageLength - message.length - 100));
  }

  const fullMessage = `${message}${errorDetails}`.slice(0, maxMessageLength);

  try {
    const response = await fetch(
      `https://api.telegram.org/bot${TELEGRAM_CONFIG.botToken}/sendMessage`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: TELEGRAM_CONFIG.chatId,
          text: fullMessage,
          parse_mode: "Markdown",
          disable_web_page_preview: true
        })
      }
    );

    if (!response.ok) {
      console.error("Error de Telegram:", await response.text());
    }
  } catch (error) {
    console.error("Error enviando alerta:", error);
  }
}

// ======================
// Lógica principal
// ======================
async function getPlayerInventory() {
  try {
    const response = await fetch(`https://sky.shiiyu.moe/api/v2/profile/${PLAYER_NAME}`);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    
    const data = await response.json();
    if (!data?.profiles) throw new Error("Estructura de datos inválida");

    const currentProfile = Object.values(data.profiles).find(p => p.current);
    if (!currentProfile?.data?.items) throw new Error("Perfil no encontrado");

    // Procesamiento de items (similar al anterior pero con más validaciones)
    // ... (mantener tu lógica de processContainer y processStorage)

    return processedData;
  } catch (error) {
    await sendTelegramAlert(`❌ Fallo al obtener inventario de ${PLAYER_NAME}`, error);
    throw error;
  }
}

async function checkInventoryChanges() {
  try {
    const inventoryData = await getPlayerInventory();
    const [prevInventory, investmentRecord] = await Promise.all([
      getFirebaseData("prev_inventory"),
      getFirebaseData("investment_record")
    ]);

    // Lógica de comparación y detección de cambios
    // ... (similar al anterior pero con más validaciones)

    if (changesDetected) {
      await sendTelegramAlert(`✅ Cambios detectados en ${PLAYER_NAME}:\n${changeSummary}`);
    }

    await Promise.all([
      updateFirebaseData("prev_inventory", currentInventory),
      updateFirebaseData("investment_record", newInvestmentRecord)
    ]);

  } catch (error) {
    await sendTelegramAlert(`⛔ Error crítico en el proceso principal`, error);
    throw error;
  }
}

// ======================
// Inicialización y ejecución
// ======================
(async () => {
  try {
    validateEnvironment();
    initializeApp(FIREBASE_CONFIG);
    console.log("🔥 Firebase inicializado correctamente");
    
    await checkInventoryChanges();
    await sendTelegramAlert("🟢 Ejecución completada exitosamente");
    
  } catch (error) {
    console.error("Error durante la ejecución:", error);
    process.exit(1);
  }
})();

// ======================
// Manejo de errores globales
// ======================
process.on("uncaughtException", async error => {
  await sendTelegramAlert("💥 Excepción no capturada", error);
  process.exit(1);
});

process.on("unhandledRejection", async (reason, promise) => {
  await sendTelegramAlert("⚠️ Promesa no manejada", reason);
  process.exit(1);
});
