import { DIAGNOSIS_PROMPT_V1_0_0 } from './diagnosis.prompt.js';
import { PromptRenderError, PromptTemplate, RenderedPrompt } from './prompt.types.js';

/* ------------------------------------------------------------------ */
/*  Prompt Rendering & Immutability Verification (AI-010)            */
/* ------------------------------------------------------------------ */

/**
 * Renders a prompt template with strict variable validation.
 * Errors if any declared variable is missing or if any undeclared variable is supplied.
 */
export function renderPrompt(
  template: PromptTemplate,
  variables: Record<string, string>
): RenderedPrompt {
  const suppliedKeys = Object.keys(variables);
  const declaredKeys = template.variables;

  // 1. Check for missing required variables
  for (const key of declaredKeys) {
    if (!(key in variables) || variables[key] === undefined || variables[key] === null) {
      throw new PromptRenderError(
        `Missing required prompt variable '${key}' for template '${template.id}' (${template.version})`,
        template.id,
        template.version
      );
    }
  }

  // 2. Check for unexpected variables
  for (const key of suppliedKeys) {
    if (!declaredKeys.includes(key)) {
      throw new PromptRenderError(
        `Unexpected prompt variable '${key}' supplied for template '${template.id}' (${template.version})`,
        template.id,
        template.version
      );
    }
  }

  // 3. Perform exact variable substitutions
  let renderedTemplate = template.template;
  for (const key of declaredKeys) {
    const placeholder = `{{${key}}}`;
    renderedTemplate = renderedTemplate.replaceAll(placeholder, variables[key] ?? '');
  }

  return {
    promptId: template.id,
    promptVersion: template.version,
    systemPrompt: template.systemPrompt,
    userPrompt: renderedTemplate
  };
}

/* ------------------------------------------------------------------ */
/*  In-Memory Versioned Prompt Registry (AI-010)                      */
/* ------------------------------------------------------------------ */

class PromptRegistry {
  private templates = new Map<string, Map<string, PromptTemplate>>();

  constructor() {
    this.register(DIAGNOSIS_PROMPT_V1_0_0);
  }

  /**
   * Registers a prompt template. Released templates are immutable.
   */
  public register(template: PromptTemplate): void {
    let versionMap = this.templates.get(template.id);
    if (!versionMap) {
      versionMap = new Map<string, PromptTemplate>();
      this.templates.set(template.id, versionMap);
    }

    if (versionMap.has(template.version)) {
      throw new Error(
        `Prompt template '${template.id}' version '${template.version}' is already registered and immutable.`
      );
    }

    // Freeze template object to enforce immutability
    versionMap.set(template.version, Object.freeze({ ...template }));
  }

  /**
   * Retrieves a template by ID and version. Defaults to active environment version or 'v1.0.0'.
   */
  public getTemplate(id: string, version?: string): PromptTemplate {
    const versionMap = this.templates.get(id);
    if (!versionMap) {
      throw new Error(`Prompt template with ID '${id}' not found in registry.`);
    }

    const targetVersion =
      version ||
      (id === 'payment_failure_diagnosis'
        ? process.env.DIAGNOSIS_PROMPT_VERSION || 'v1.0.0'
        : 'v1.0.0');

    const template = versionMap.get(targetVersion);
    if (!template) {
      throw new Error(
        `Prompt template '${id}' version '${targetVersion}' not found in registry.`
      );
    }

    return template;
  }

  /**
   * Lists all available prompt template versions for a given task/id.
   */
  public listVersions(id: string): string[] {
    const versionMap = this.templates.get(id);
    return versionMap ? Array.from(versionMap.keys()) : [];
  }
}

export const promptRegistry = new PromptRegistry();
