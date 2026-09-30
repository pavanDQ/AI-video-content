/**
 * Deterministic storyboard planner.
 *
 * Used when no ANTHROPIC_API_KEY is configured, and as the fallback when the
 * AI script writer is unreachable. It produces the same storyboard shape as
 * the AI path, so nothing downstream needs to know which one ran.
 */

const ORGAN_KEYWORDS = [
  [/\b(lung|pulmonar|respirat|asthma|copd|bronch)/i, 'lungs'],
  [/\b(heart|cardiac|cardio|myocard|coronary|ventric)/i, 'heart'],
  [/\b(brain|neuro|cerebr|stroke|cognit|seizure)/i, 'brain'],
  [/\b(kidney|renal|nephro|dialys)/i, 'kidney'],
  [/\b(liver|hepat|cirrho)/i, 'liver'],
  [/\b(stomach|gastr|intestin|bowel|digest)/i, 'stomach'],
  [/\b(blood vessel|artery|arterial|vein|atheroscler|thromb)/i, 'bloodvessel'],
  [/\b(cell|tumour|tumor|cancer|carcinoma|mitosis|dna|mutation)/i, 'cell']
];

function detectOrgan(text) {
  return ORGAN_KEYWORDS.find(([pattern]) => pattern.test(text))?.[1] || 'cell';
}

function shorten(text, max = 90) {
  const clean = String(text).replace(/\s+/g, ' ').trim();
  return clean.length > max ? `${clean.slice(0, max - 1).trimEnd()}…` : clean;
}

function splitSentences(content) {
  return content
    .replace(/\s+/g, ' ')
    .split(/(?<=[.!?])\s+/)
    .map(sentence => sentence.trim())
    .filter(sentence => sentence.length > 15)
    .slice(0, 10);
}

function chunk(items, size) {
  const output = [];
  for (let i = 0; i < items.length; i += size) output.push(items.slice(i, i + size));
  return output;
}

function chooseVisualType(text, index, visualStyle) {
  if (visualStyle && visualStyle !== 'AI decides') {
    return {
      'Whiteboard': 'whiteboard',
      'Medical animation': 'medical-animation',
      'Doctor presentation': 'avatar',
      'Anatomy illustration': 'anatomy',
      'Step diagram': 'diagram'
    }[visualStyle] || 'whiteboard';
  }

  const lower = text.toLowerCase();
  if (/\b(versus|vs\.?|compared|difference|differenti|distinguish)/.test(lower)) return 'comparison';
  if (/\b(step|stage|process|pathway|progress|leads to|results in|mechanism)/.test(lower)) return 'diagram';
  if (/\b(lung|heart|brain|kidney|liver|stomach|artery|vein|cell|tumour|tumor)/.test(lower)) return 'anatomy';
  if (/\b(increase|decrease|change|over time|develop|worsen)/.test(lower)) return 'medical-animation';
  return index % 2 === 0 ? 'whiteboard' : 'diagram';
}

function buildVisualData(text, visualType, topic) {
  const short = shorten(text, 85);

  switch (visualType) {
    case 'comparison':
      return {
        heading: 'Key differences',
        leftTitle: 'First consideration', leftItems: [short, 'Typical presentation', 'Clinical relevance'],
        rightTitle: 'Second consideration', rightItems: ['How it differs', 'Distinguishing feature', 'Clinical relevance']
      };
    case 'diagram':
      return { heading: 'Step by step', steps: ['Starting point', short, 'What changes', 'Clinical meaning'] };
    case 'medical-animation':
      return { heading: 'How it progresses', labels: ['Baseline', 'Change', 'Outcome'] };
    case 'anatomy':
      return { heading: shorten(topic, 50), organ: detectOrgan(text), labels: ['Structure', 'Change', 'Effect'] };
    case 'avatar':
      return { heading: shorten(topic, 50), points: [short] };
    default:
      return { heading: 'Key point', points: [short, 'Why it matters', 'What to remember'] };
  }
}

/** Build a storyboard from the topic alone. */
function planFromTopic(topic, visualStyle) {
  const organ = detectOrgan(topic);
  return [
    {
      title: 'Introduction', seconds: 6, visualType: 'avatar',
      narration: `Let us look at ${topic}. This short video breaks the topic down into the core concept, how it develops, and the points worth remembering in practice.`,
      highlight: 'Overview', visualData: { heading: topic }
    },
    {
      title: 'Core concept', seconds: 7,
      visualType: visualStyle === 'AI decides' ? 'whiteboard' : chooseVisualType(topic, 1, visualStyle),
      narration: `First, the underlying concept. Understanding the definition and the terms that surround ${topic} makes everything that follows easier to place.`,
      highlight: 'The underlying concept',
      visualData: { heading: topic, points: ['What it is', 'Terms that matter', 'Why it matters clinically'] }
    },
    {
      title: 'Structure and change', seconds: 8, visualType: 'anatomy',
      narration: 'Seeing the structures involved makes the mechanism much clearer than description alone, so here is what changes and where.',
      highlight: 'What changes, and where',
      visualData: { heading: 'Structures involved', organ, labels: ['Structure', 'Change', 'Effect'] }
    },
    {
      title: 'How it progresses', seconds: 7, visualType: 'diagram',
      narration: 'Laying the sequence out in order shows how one stage leads into the next, and where the clinically important transitions sit.',
      highlight: 'Sequence of events',
      visualData: { heading: 'Sequence of events', steps: ['Initial state', 'First change', 'Progression', 'Clinical presentation'] }
    },
    {
      title: 'Summary', seconds: 6, visualType: 'whiteboard',
      narration: `To summarise, keep three things in mind about ${topic}. The core concept, the sequence in which it develops, and the points that change how you would act on it.`,
      highlight: 'Key takeaways',
      visualData: { heading: 'Key takeaways', points: ['The core concept', 'How it develops', 'What to act on'] }
    }
  ];
}

/** Build a storyboard from content the user supplied. */
function planFromContent(topic, content, visualStyle) {
  const sentences = splitSentences(content);
  if (!sentences.length) return planFromTopic(topic, visualStyle);

  const scenes = [{
    title: 'Introduction', seconds: 6, visualType: 'avatar',
    narration: `Let us work through ${topic}, using the content provided. I will break it into a few key points with a visual explanation for each.`,
    highlight: 'Overview', visualData: { heading: topic }
  }];

  chunk(sentences, 2).slice(0, 4).forEach((group, index) => {
    const text = group.join(' ');
    const visualType = chooseVisualType(text, index, visualStyle);
    scenes.push({
      title: `Key point ${index + 1}`,
      seconds: 8,
      narration: shorten(text, 320),
      visualType,
      highlight: shorten(text.split(/[,.;]/)[0] || 'Key point', 60),
      visualData: buildVisualData(text, visualType, topic)
    });
  });

  scenes.push({
    title: 'Summary', seconds: 6, visualType: 'whiteboard',
    narration: `In summary, those are the main points to carry forward about ${topic}.`,
    highlight: 'Key takeaways',
    visualData: { heading: 'Key takeaways', points: sentences.slice(0, 3).map(sentence => shorten(sentence, 80)) }
  });

  return scenes;
}

export function planLocally({ topic, duration, sourceContent, visualStyle }) {
  const cleanTopic = (topic || '').trim() || 'this medical topic';
  const content = (sourceContent || '').trim();
  const scenes = content
    ? planFromContent(cleanTopic, content, visualStyle)
    : planFromTopic(cleanTopic, visualStyle);

  const target = Math.max(15, Number(duration) || 30);
  const total = scenes.reduce((sum, scene) => sum + scene.seconds, 0);
  const scale = target / total;

  return {
    title: cleanTopic,
    summary: content
      ? `An explainer built from the supplied content on ${cleanTopic}.`
      : `A structured overview of ${cleanTopic}.`,
    reviewNotes: [
      'This storyboard was generated by the offline planner, not by the AI script writer. Review every clinical statement before approval.'
    ],
    scenes: scenes.map(scene => ({ ...scene, seconds: Math.max(3, Math.round(scene.seconds * scale)) }))
  };
}
