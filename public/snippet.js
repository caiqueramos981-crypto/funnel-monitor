(function () {
  const currentScript = document.currentScript;

  const SERVER =
    currentScript?.dataset?.server ||
    "https://funnel-monitor-production.up.railway.app";

  const FUNNEL =
    currentScript?.dataset?.funnel || "default";

  // =========================
  // DETECÇÃO AUTOMÁTICA
  // =========================

  const url = window.location.href.toLowerCase();
  const path = window.location.pathname.toLowerCase();
  const host = window.location.hostname.toLowerCase();

  let page = "unknown";

  // QUIZ
  if (
    url.includes("quiz") ||
    path.includes("quiz") ||
    document.title.toLowerCase().includes("quiz")
  ) {
    page = "quiz";
  }

  // RESULTADO
  else if (
    url.includes("resultado") ||
    url.includes("result") ||
    path.includes("resultado") ||
    document.title.toLowerCase().includes("resultado")
  ) {
    page = "resultado";
  }

  // VENDAS
  else if (
    url.includes("vendas") ||
    url.includes("oferta") ||
    url.includes("sales") ||
    path.includes("vendas")
  ) {
    page = "vendas";
  }

  // CHECKOUT
 else if (
  host.includes("lowify") ||
  url.includes("checkout") ||
  path.includes("checkout") ||
  url.includes("payment")
) {
  page = "checkout";
}

  // UPSELL
  else if (
    url.includes("upsell") ||
    url.includes("upgrade") ||
    path.includes("upsell")
  ) {
    page = "upsell";
  }

  // OBRIGADO
  else if (
    url.includes("obrigado") ||
    url.includes("thank") ||
    path.includes("obrigado")
  ) {
    page = "obrigado";
  }

  // =========================
  // SESSION
  // =========================

  let sessionId = localStorage.getItem("fm_session");

  if (!sessionId) {
    sessionId =
      Date.now() + "_" + Math.random().toString(36).substring(2);

    localStorage.setItem("fm_session", sessionId);
  }

  // =========================
  // UTM CAPTURE
  // =========================

  const params = new URLSearchParams(window.location.search);

  const utms = {
    utm_source: params.get("utm_source") || "",
    utm_medium: params.get("utm_medium") || "",
    utm_campaign: params.get("utm_campaign") || "",
    utm_content: params.get("utm_content") || "",
    utm_term: params.get("utm_term") || "",
  };

  // =========================
  // DEVICE
  // =========================

  const device = /mobile/i.test(navigator.userAgent)
    ? "mobile"
    : "desktop";

  // =========================
  // PAYLOAD
  // =========================

  const payload = {
    sessionId,
    page,
    funnel: FUNNEL,
    url: window.location.href,
    referrer: document.referrer || "",
    timestamp: Date.now(),
    device,
    utms,
  };

  // =========================
  // SEND EVENT
  // =========================

  fetch(`${SERVER}/track`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  }).catch(() => {});

  // =========================
  // TEMPO NA PÁGINA
  // =========================

  const startTime = Date.now();

  window.addEventListener("beforeunload", () => {
    const duration = Math.floor((Date.now() - startTime) / 1000);

    navigator.sendBeacon(
      `${SERVER}/time`,
      JSON.stringify({
        sessionId,
        page,
        duration,
        funnel: FUNNEL,
      })
    );
  });

  // =========================
  // DEBUG
  // =========================

  console.log("⚡ Funnel Monitor");
  console.log("Página detectada:", page);
})();

app.post('/webhook/lowify', (req, res) => {

  console.log('LOWIFY WEBHOOK RECEBIDO');
  console.log(req.body);

  res.json({
    success: true
  });

});