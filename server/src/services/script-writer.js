/**
 * AI script writer.
 *
 * Turns a topic (and optionally the clinician's own source content) into a
 * storyboard: scenes with narration, a visual treatment, and the on-screen
 * data each visual needs. Claude does the authoring; the deterministic planner
 * in `local-planner.js` covers the no-API-key case.
 */

import Anthropic from '@anthropic-ai/sdk';
import { planLocally } from './local-planner.js';

const VISUAL_TYPES = ['avatar', 'whiteboard', 'diagram', 'comparison', 'medical-animation', 'anatomy'];

/**
 * Response schema. `additionalProperties: false` everywhere keeps the model
 * from inventing fields the renderer would silently ignore.
 */
const STORYBOARD_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['title', 'summary', 'scenes'],
  properties: {
    title: { type: 'string', description: 'Short on-screen title for the video.' },
    summary: { type: 'string', description: 'One sentence describing what a doctor will learn.' },
    reviewNotes: {
      type: 'array',
      description: 'Claims a medical reviewer should verify before approval.',
      items: { type: 'string' }
    },
    scenes: {
      type: 'array',
      minItems: 3,
      maxItems: 8,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['title', 'narration', 'visualType', 'seconds', 'visualData'],
        properties: {
          title: { type: 'string' },
          narration: {
            type: 'string',
            description: 'Exactly what the AI presenter says. Plain spoken prose, no markup, no stage directions.'
          },
          seconds: { type: 'number', description: 'Intended on-screen duration.' },
          visualType: { type: 'string', enum: VISUAL_TYPES },
          highlight: { type: 'string', description: 'Short phrase shown as the scene headline.' },
          visualData: {
            type: 'object',
            additionalProperties: false,
            properties: {
              heading: { type: 'string' },
              points: { type: 'array', items: { type: 'string' } },
              steps: { type: 'array', items: { type: 'string' } },
              labels: { type: 'array', items: { type: 'string' } },
              leftTitle: { type: 'string' },
              leftItems: { type: 'array', items: { type: 'string' } },
              rightTitle: { type: 'string' },
              rightItems: { type: 'array', items: { type: 'string' } },
              organ: {
                type: 'string',
                description: 'For anatomy scenes: cell, lungs, heart, brain, kidney, liver, stomach or bloodvessel.'
              }
            }
          }
        }
      }
    }
  }
};

const SYSTEM_PROMPT = `You are a medical content producer writing short explainer videos that will be reviewed by a physician before being published to other doctors.

How to write the narration:
- It is spoken aloud by an AI presenter, so write plain spoken prose. No markdown, no bullet characters, no stage directions, no emoji, no parentheses containing asides.
- Expand abbreviations the first time they appear, because a text-to-speech engine will read them literally.
- Write numbers and units the way they should be said out loud ("five milligrams per decilitre", not "5 mg/dL").
- Keep each scene's narration to what can be comfortably spoken in its allotted seconds at roughly 165 words per minute.

How to choose visuals: each scene pairs narration with one visual treatment.
- avatar: the presenter alone, for openings and closings.
- whiteboard: a handwritten list of points being drawn as they are spoken.
- diagram: an ordered sequence, for processes, pathways and progressions.
- comparison: two labelled columns, for distinguishing between entities.
- medical-animation: three pulsing stages, for change over time.
- anatomy: an animated organ or cell schematic. Set visualData.organ.

Clinical accuracy rules:
- State only what is well established. Do not invent doses, statistics, percentages, trial names or guideline numbers.
- If the user supplied source content, the narration must stay faithful to it and must not add clinical claims it does not support.
- Put anything a reviewer must confirm into reviewNotes.
- Never phrase content as advice for an individual patient.`;

function buildUserPrompt({ category, topic, duration, sourceContent, visualStyle, audience }) {
  const lines = [
    `Category: ${category}`,
    `Topic: ${topic}`,
    `Target total duration: ${duration} seconds`,
    `Audience: ${audience || 'practising doctors'}`,
    `Preferred visual style: ${visualStyle}`
  ];

  if (visualStyle && visualStyle !== 'AI decides') {
    lines.push(`Favour the "${visualStyle}" treatment, but vary it where another treatment explains the content better.`);
  }

  if (sourceContent?.trim()) {
    lines.push(
      '',
      'Base the video on this source content. Stay faithful to it and do not introduce clinical claims it does not support:',
      '"""',
      sourceContent.trim(),
      '"""'
    );
  } else {
    lines.push('', 'No source content was supplied. Write a well-established overview of the topic.');
  }

  lines.push(
    '',
    `Scene seconds must add up to about ${duration}. Open with an avatar scene and close with a summary.`
  );

  return lines.join('\n');
}

export function isAiAvailable() {
  return Boolean(process.env.ANTHROPIC_API_KEY);
}

/**
 * Write a storyboard.
 *
 * Falls back to the local planner when no API key is configured, or when the
 * API call fails — a POC demo should never dead-end on a network error.
 */
export async function writeScript(request) {
  if (!isAiAvailable()) {
    return { ...planLocally(request), source: 'local-planner' };
  }

  const client = new Anthropic();

  try {
    const response = await client.messages.create({
      model: process.env.ANTHROPIC_MODEL || 'claude-opus-5',
      max_tokens: 16000,
      system: SYSTEM_PROMPT,
      thinking: { type: 'adaptive' },
      output_config: {
        effort: 'medium',
        format: { type: 'json_schema', schema: STORYBOARD_SCHEMA }
      },
      messages: [{ role: 'user', content: buildUserPrompt(request) }]
    });

    if (response.stop_reason === 'refusal') {
      throw new Error(`Model declined to write this script: ${response.stop_details?.explanation || 'no explanation given'}`);
    }

    const text = response.content
      .filter(block => block.type === 'text')
      .map(block => block.text)
      .join('');

    const storyboard = JSON.parse(text);
    return {
      ...normalize(storyboard, request),
      source: 'claude',
      model: response.model,
      usage: response.usage
    };
  } catch (error) {
    // Degrade rather than fail: the reviewer can still see and edit a plan.
    return {
      ...planLocally(request),
      source: 'local-planner',
      warning: `AI script writer unavailable, used the local planner instead. ${error.message}`
    };
  }
}

/** Clamp AI output to what the renderer can actually draw. */
function normalize(storyboard, request) {
  const target = Math.max(15, Number(request.duration) || 30);
  const scenes = (storyboard.scenes || [])
    .filter(scene => scene?.narration?.trim())
    .map(scene => ({
      title: String(scene.title || 'Scene').slice(0, 80),
      narration: String(scene.narration).replace(/\s+/g, ' ').trim(),
      visualType: VISUAL_TYPES.includes(scene.visualType) ? scene.visualType : 'whiteboard',
      seconds: Math.max(3, Math.min(30, Number(scene.seconds) || 6)),
      highlight: scene.highlight ? String(scene.highlight).slice(0, 90) : '',
      visualData: scene.visualData || {}
    }));

  // Scene length is ultimately set by how long the voice takes to say the
  // narration; these seconds are the planning estimate shown in the UI.
  const total = scenes.reduce((sum, scene) => sum + scene.seconds, 0) || 1;
  const scale = target / total;

  return {
    title: storyboard.title || request.topic,
    summary: storyboard.summary || '',
    reviewNotes: Array.isArray(storyboard.reviewNotes) ? storyboard.reviewNotes : [],
    scenes: scenes.map(scene => ({ ...scene, seconds: Math.max(3, Math.round(scene.seconds * scale)) }))
  };
}
