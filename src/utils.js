// COPIED from docs/.vitepress/utils.js — keep in sync with the original in web-template.
// The config-api Worker can't import modules from the web-template package path,
// so this duplicate is maintained here. When the upstream utils.js changes,
// copy it here too.
export function groupEvents(events, fields = []) {
  if (fields.length === 0) return events;
  const field = fields[0];
  const grouped = events.reduce((acc, event) => {
    const key_array = accessMultikey(event, field);
    for (const key of key_array) {
      if (!acc[key]) acc[key] = [];
      if (fields.length > 1 || field == "all") acc[key].push(event);
    }
    return acc;
  }, {});

  if (field == "times") {
    return Object.keys(grouped)
      .sort((a, b) => a.localeCompare(b))
      .reduce((acc, key) => {
        acc[key] = groupEvents(grouped[key], fields.slice(1));
        return acc;
      }, {});
  }

  Object.keys(grouped).forEach((key) => {
    grouped[key] = groupEvents(grouped[key], fields.slice(1));
  });
  return grouped;
}

// Assembles the event grouping order from the new per-level single-select
// fields (orderTabla, orderFila, orderColumna, orderSubfila, orderNotas) into
// the flat array that groupEvents() expects.  Falls back to the legacy `order`
// array for existing configs, then to a sensible default.
//
// Important: groupEvents reads the array by index, so each level must stay in
// its fixed position.  We do NOT filter out unset levels — instead we emit the
// "empty" sentinel (a valid option from the ordering component) so positional
// integrity is preserved.  Calendar.vue already hides "" keys via CSS
// (h3:empty, td:empty { display: none }).
export function assembleOrder(section) {
  const LEVELS = [
    "orderTabla",
    "orderFila",
    "orderColumna",
    "orderSubfila",
    "orderNotas",
  ];

  // New format: always return all 5 levels in order, using "empty" as a
  // placeholder for unset levels to preserve positional integrity.
  if (LEVELS.some((f) => section[f])) {
    return LEVELS.map((f) => section[f] || "empty");
  }

  // Backward compatibility: legacy `order` array
  if (Array.isArray(section.order) && section.order.length) {
    return section.order;
  }

  // Default fallback
  return ["type", "times"];
}

export function toArray(value) {
  if (Array.isArray(value)) {
    if (value.length) return value;
    return [];
  }
  if (typeof value === "string") return [value];
  return [];
}

export function accessMultikey(obj, multikey) {
  let result = [];

  // 1. Split by '+' to get additive groups
  const groups = multikey.split("+");

  for (const group of groups) {
    // 2. Split by '/' for fallbacks
    const fallbacks = group.split("/");

    for (const fallback of fallbacks) {
      // 3. Split by '-' for subtractions within this fallback
      const [mainKey, ...keysToSubtract] = fallback.split("-");

      let value = toArray(obj[mainKey]);
      if (mainKey == "weekday") value = weekday(obj.byday);
      if (mainKey == "byday") value = formatWeekdays(obj.byday);

      if (value.length > 0) {
        // If there are subtraction keys, filter the current values
        for (const subKey of keysToSubtract) {
          let subtractValues = toArray(obj[subKey]);
          if (subKey == "weekday") subtractValues = weekday(obj.byday);
          if (subKey == "byday") subtractValues = formatWeekdays(obj.byday);
          if (!subtractValues.length) subtractValues = [subKey];
          value = value.filter((val) => !subtractValues.includes(val));
        }

        result = result.concat(value);
        break; // Found a valid fallback, stop looking in this group
      }
    }
  }
  return result.length ? result.filter(Boolean) : [""];
}

export function applyComplexFilter(obj, filter) {
  if (!filter) return true;

  const content = JSON.stringify(obj).toLowerCase().replaceAll('":[]', ":empty");

  // 1. Split by OR (|) - Any one of these groups must be true
  const orParts = filter.toLowerCase().split("|");

  return orParts.some((orPart) => {
    // 2. Split by AND (&) - All of these terms must be true
    const andTerms = orPart.split("&");

    return andTerms.every((term) => {
      let searchTerm = term.trim();
      let isNegated = false;

      // 3. Handle the negation (!) at the start of any term
      if (searchTerm.startsWith("!")) {
        isNegated = true;
        searchTerm = searchTerm.slice(1).trim();
      }

      const found = content.includes(searchTerm);

      // If negated, we want NOT found. Otherwise, we want found.
      return isNegated ? !found : found;
    });
  });
}

export function formatWeekdays(days) {
  // 1. Define the reference order
  const order = ["MO", "TU", "WE", "TH", "FR", "SA", "SU"];

  // 2. Sort the array based on the reference order
  const sortedDays = [...days].sort((a, b) => order.indexOf(a) - order.indexOf(b));

  // 3. Check for the "mo" through "fr" sequence
  const workDays = ["MO", "TU", "WE", "TH", "FR"];
  const hasAllWorkDays = workDays.every((day) => sortedDays.includes(day));

  if (hasAllWorkDays) {
    // Remove mo, tu, we, th, fr and replace with the string
    const others = sortedDays.filter((day) => !workDays.includes(day));
    return ["MO,TU,WE,TH,FR", ...others];
  }

  return sortedDays;
}

function weekday(days) {
  const w = [];
  if (days.join(",").match(/mo|tu|we|th|fr/i)) w.push("MO,TU,WE,TH,FR");
  if (days.join(",").toLowerCase().includes("sa")) w.push("SA");
  if (days.join(",").toLowerCase().includes("su")) w.push("SU");
  return w;
}

export function formatDate(isoString, lang = "Español:es") {
  if (typeof isoString !== "string") return "";
  if (typeof lang !== "string") return isoString;
  const langCode = lang.split(":")[1];
  const date = new Date(isoString.split("/")?.toReversed()?.join("-"));
  if (isNaN(date.getTime())) return tr(isoString, lang);
  const monthIndex = date.getMonth();
  const now = new Date();
  const note = date.getFullYear() < now.getFullYear() ? `(${date.getFullYear()})` : "";

  const months = {
    eu: ["Urtarrilak", "Otsailak", "Martxoak", "Apirilak", "Maiatzak", "Ekainak", "Uztailak", "Abuztuak", "Irailak", "Urriak", "Azaroak", "Abenduak"],
    es: ["Enero", "Febrero", "Marzo", "Abril", "Mayo", "Junio", "Julio", "Agosto", "Septiembre", "Octubre", "Noviembre", "Diciembre"],
    en: ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"],
    bg: ["Януари", "Февруари", "Март", "Април", "Май", "Юни", "Юли", "Август", "Септември", "Октомври", "Ноември", "Декември"],
    it: ["Gennaio", "Febbraio", "Marzo", "Aprile", "Maggio", "Giugno", "Luglio", "Agosto", "Settembre", "Ottobre", "Novembre", "Dicembre"],
    ro: ["Ianuarie", "Februarie", "Martie", "Aprilie", "Mai", "Iunie", "Iulie", "August", "Septembrie", "Octombrie", "Noiembrie", "Decembrie"],
    pt: ["Janeiro", "Fevereiro", "Março", "Abril", "Maio", "Junho", "Julho", "Agosto", "Setembro", "Outubro", "Novembre", "Dezembre"],
    ca: ["Gener", "Febrer", "Març", "Abril", "Maig", "Juny", "Juliol", "Agost", "Setembre", "Octubre", "Novembre", "Desembre"],
    ar: ["يناير", "فبراير", "مارس", "أبريل", "مايو", "يونيو", "يوليو", "أغسطس", "سبتمبر", "أكتوبر", "نوفمبر", "ديسمبر"],
    de: ["Januar", "Februar", "März", "April", "Mai", "Juni", "Juli", "August", "September", "Oktober", "November", "Dezember"],
    fr: ["Janvier", "Février", "Mars", "Avril", "Mai", "Juin", "Juillet", "Août", "Septembre", "Octobre", "Novembre", "Décembre"],
    default: ["-I", "-II", "-III", "-IV", "-V", "-VI", "-VII", "-VIII", "-IX", "-X", "-XI", "-XII"],
  };

  const names = months[langCode] || months["default"];
  return langCode === "eu" ? `${names[monthIndex]} ${date.getDate()} ${note}`.trim() : `${date.getDate()} ${names[monthIndex]} ${note}`.trim();
}

function tr(str, lang = "Español:es") {
  if (!str) return "";
  const langCode = lang.split(":")[1];
  const map = {
    eu: {
      mo: "Astelehenetan",
      tu: "Asteartetan",
      we: "Asteazkenetan",
      th: "Ostegunetan",
      fr: "Ostiraletan",
      sa: "Larunbatetan",
      su: "Igandetan",
      "mo,tu,we,th,fr": "Astelehenetik ostiralera",
      yearly: "Urtero",
      monthly: "Hilero",
      biweekly: "Bi astetik behin",
      week1: "1. astea",
      week2: "2. astea",
      week3: "3. astea",
      week4: "4. astea",
      week5: "5. astea",
    },
    es: {
      mo: "Lunes",
      tu: "Martes",
      we: "Miércoles",
      th: "Jueves",
      fr: "Viernes",
      sa: "Sábados",
      su: "Domingos",
      "mo,tu,we,th,fr": "Lunes a viernes",
      yearly: "Anualmente",
      monthly: "Mensualmente",
      biweekly: "Cada dos semanas",
      week1: "1ª semana",
      week2: "2ª semana",
      week3: "3ª semana",
      week4: "4ª semana",
      week5: "5ª semana",
    },
    ca: {
      mo: "Dilluns",
      tu: "Dimarts",
      we: "Dimecres",
      th: "Dijous",
      fr: "Divendres",
      sa: "Dissabte",
      su: "Diumenge",
      "mo,tu,we,th,fr": "De dilluns a divendres",
      yearly: "Anualment",
      monthly: "Mensualment",
      biweekly: "Cada dues setmanes",
      week1: "1a setmana",
      week2: "2a setmana",
      week3: "3a setmana",
      week4: "4a setmana",
      week5: "5a setmana",
    },
    en: {
      mo: "Monday",
      tu: "Tuesday",
      we: "Wednesday",
      th: "Thursday",
      fr: "Friday",
      sa: "Saturday",
      su: "Sunday",
      "mo,tu,we,th,fr": "Monday to Friday",
      yearly: "Yearly",
      monthly: "Monthly",
      biweekly: "Biweekly",
      week1: "1st week",
      week2: "2nd week",
      week3: "3rd week",
      week4: "4th week",
      week5: "5th week",
    },
    fr: {
      mo: "Lundi",
      tu: "Mardi",
      we: "Mercredi",
      th: "Jeudi",
      fr: "Vendredi",
      sa: "Samedi",
      su: "Dimanche",
      "mo,tu,we,th,fr": "Du lundi au vendredi",
      yearly: "Annuellement",
      monthly: "Mensuellement",
      biweekly: "Toutes les deux semaines",
      week1: "1re semaine",
      week2: "2e semaine",
      week3: "3e semaine",
      week4: "4e semaine",
      week5: "5e semaine",
    },
    de: {
      mo: "Montag",
      tu: "Dienstag",
      we: "Mittwoch",
      th: "Donnerstag",
      fr: "Freitag",
      sa: "Samstag",
      su: "Sonntag",
      "mo,tu,we,th,fr": "Montag bis Freitag",
      yearly: "Jährlich",
      monthly: "Monatlich",
      biweekly: "Alle zwei Wochen",
      week1: "1. Woche",
      week2: "2. Woche",
      week3: "3. Woche",
      week4: "4. Woche",
      week5: "5. Woche",
    },
    it: {
      mo: "Lunedì",
      tu: "Martedì",
      we: "Mercoledì",
      th: "Giovedì",
      fr: "Venerdì",
      sa: "Sabato",
      su: "Domenica",
      "mo,tu,we,th,fr": "Da lunedì a venerdì",
      yearly: "Annualmente",
      monthly: "Mensilmente",
      biweekly: "Ogni due settimane",
      week1: "1ª settimanae",
      week2: "2ª settimanae",
      week3: "3ª settimanae",
      week4: "4ª settimanae",
      week5: "5ª settimanae",
    },
    pt: {
      mo: "Segunda-feira",
      tu: "Terça-feira",
      we: "Quarta-feira",
      th: "Quinta-feira",
      fr: "Sexta-feira",
      sa: "Sábado",
      su: "Domingo",
      "mo,tu,we,th,fr": "De segunda a sexta-feira",
      yearly: "Anualmente",
      monthly: "Mensualmente",
      biweekly: "A cada duas semanas",
      week1: "1ª semana",
      week2: "2ª semana",
      week3: "3ª semana",
      week4: "4ª semana",
      week5: "5ª semana",
    },
    ro: {
      mo: "Luni",
      tu: "Marți",
      we: "Miercuri",
      th: "Joi",
      fr: "Vineri",
      sa: "Sâmbătă",
      su: "Duminică",
      "mo,tu,we,th,fr": "De luni până vineri",
      yearly: "Anual",
      monthly: "Lunar",
      biweekly: "La fiecare două săptămâni",
      week1: "Prima săptămână",
      week2: "A doua săptămână",
      week3: "A treia săptămână",
      week4: "A patra săptămână",
      week5: "A cincea săptămână",
    },
    ar: {
      mo: "الاثنين",
      tu: "الثلاثاء",
      we: "الأربعاء",
      th: "الخميس",
      fr: "الجمعة",
      sa: "السبت",
      su: "الأحد",
      "mo,tu,we,th,fr": "من الاثنين إلى الجمعة",
      yearly: "سنوياً",
      monthly: "شهرياً",
      biweekly: "كل أسبوعين",
      week1: "الأسبوع الأول من الشهر",
      week2: "الأسبوع الثاني من الشهر",
      week3: "الأسبوع الثالث من الشهر",
      week4: "الأسبوع الرابع من الشهر",
      week5: "الأسبوع الخامس من الشهر",
    },
    bg: {
      mo: "Понеделник",
      tu: "Вторник",
      we: "Сряда",
      th: "Четвъртък",
      fr: "Петък",
      sa: "Събота",
      su: "Неделя",
      "mo,tu,we,th,fr": "От понеделник до петък",
      yearly: "Годишно",
      monthly: "Месечно",
      biweekly: "На всеки две седмици",
      week1: "Първа седмица",
      week2: "Втора седмица",
      week3: "Трета седмица",
      week4: "Четвърта седмица",
      week5: "Пета седмица",
    },
  };
  return map[langCode]?.[str.toLowerCase()] || str;
}

export function slugify(str) {
  if (!str) return "";

  const slug = str
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  return slug || `${hash(str)}`;
}

function hash(s) {
  let h = 0;
  for (const c of s) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return h.toString(36);
}

export function grid(section) {
  let { tags = [], elements = [] } = section;

  // Masonry layout uses CSS columns instead of flex
  if (tags.includes("masonry")) {
    return "container mx-auto columns-1 sm:columns-2 md:columns-3 gap-4 *:w-full *:break-inside-avoid";
  }

  // 1. Layout Base
  const base = "container mx-auto flex";
  const directions = {
    horizontal: "flex-nowrap overflow-x-scroll *:flex-shrink-0 hidescrollbar pr-8",
    vertical: "flex-wrap justify-center text-center",
  };
  const sizes = {
    xs: "py-2 *:w-1/2 *:sm:w-1/3 *:md:w-1/6 *:p-1",
    tiny: "py-4 *:w-1/3 *:sm:w-1/4 *:md:w-1/5 *:p-1",
    small: "py-4 *:w-1/2 *:md:w-1/3 *:lg:w-1/4 *:p-2",
    medium: "py-4 *:w-full *:sm:w-1/2 *:md:w-1/3 *:p-2 px-2",
    large: "py-4 *:w-full *:sm:w-2/3 *:p-2",
    xl: "py-4 *:w-full *:md:w-5/6 *:p-2",
  };

  // 2. Find the active size and direction
  const defaultSize = elements.length == 1 ? "large" : "medium";
  const activeSize = Object.keys(sizes).find((s) => tags.includes(s)) || defaultSize;
  const activeDirection = Object.keys(directions).find((s) => tags.includes(s)) || "vertical";

  // 3. Visual modifiers (applied via Tailwind star-variants to child elements)
  const modifiers = [];
  if (tags.includes("dense")) modifiers.push("gap-1");
  if (tags.includes("spacious")) modifiers.push("gap-6");
  if (tags.includes("cards")) modifiers.push("*:shadow-sm", "*:rounded-xl", "*:bg-white");
  if (tags.includes("bordered")) modifiers.push("*:border", "*:border-gray-200");
  if (tags.includes("flat")) modifiers.push("*:shadow-none");

  return `${base} ${directions[activeDirection]} ${sizes[activeSize]}${modifiers.length ? " " + modifiers.join(" ") : ""}`;

}

// Determine the CSS classes for a section based on its tags.
// Extracted from Layout.vue to be unit-testable.
export function getSectionClasses(tags = []) {
  const classes = [];

  if (tags.includes("dark")) {
    classes.push("[&_*]:text-white", "bg-[#222831]", "pt-4");
  }

  if (tags.includes("fullbleed")) {
    classes.push("w-full", "px-0");
  } else if (tags.includes("twocols")) {
    classes.push("w-full", "md:w-1/2", "flex-none", "align-top", "px-4", "mx-auto");
  } else {
    classes.push("block", "w-full");
  }

  if (tags.includes("narrow")) {
    classes.push("max-w-3xl", "mx-auto");
  }

  return classes;
}

export async function getAddress(lat, lng, name, zoom = 17) {
  if (!lat || !lng) return {};
  let extra = {
    google: `https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}`,
    osm: `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lng}#map=${zoom}/${lat}/${lng}`,
  };

  // IMPORTANT: Nominatim requires a custom User-Agent AND a Referer to identify
  // your app (see https://operations.osmfoundation.org/policies/nominatim/).
  // Without a Referer the public instance rejects the request and returns an
  // XML error page (not JSON), which breaks response.json() below.
  const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lng}`;

  try {
    const response = await fetch(url, {
      headers: {
        "User-Agent": "ParroquiaApp-Project-Manager (email@parroquia.app)",
        "Accept": "application/json",
        "Referer": "https://parroquia.app/",
      },
    });

    // Nominatim may return a non-OK response (429 rate-limit, 403 blocked, etc.)
    // with an XML/HTML error body instead of JSON. Bail out early with just the
    // map links.
    if (!response.ok) {
      console.error(`Lookup failed: Nominatim returned HTTP ${response.status}`);
      return extra;
    }

    // Verify the response is actually JSON before parsing. A CDN/proxy or
    // Nominatim error page can come back as text/xml or text/html even with
    // format=jsonv2 requested.
    const contentType = response.headers.get("content-type") || "";
    if (!contentType.includes("application/json")) {
      console.error(`Lookup failed: expected JSON but got ${contentType || "unknown content-type"}`);
      return extra;
    }

    const data = await response.json();

    // Nominatim returns { "error": "..." } for points it can't reverse-geocode
    // (e.g. ocean coordinates).
    if (data.error) {
      console.error(`Lookup failed: ${data.error}`);
      return extra;
    }

    return {
      ...extra,
      street: data.address?.road || data.address?.pedestrian,
      city: data.address?.hamlet || data.address?.village || data.address?.town || data.address?.city,
      zip: data.address?.postcode,
      full: data.display_name,
      region: data.address?.state,
      country: data.address?.country,
      country_code: data.address?.country_code,
      name: data.address?.amenity,
    };
  } catch (error) {
    console.error("Lookup failed:", error);
    return extra;
  }
}


// Language codes are authored "Label:code" (e.g. "Español:es"); the bit after
// ":" is the URL code, else fall back to the first two lowercase letters.
export function getCode(lang) {
  return lang.split(":")[1] || lang.slice(0, 2).toLowerCase();
}
