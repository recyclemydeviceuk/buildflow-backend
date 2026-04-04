export type LeadFieldKey =
  | 'name'
  | 'phone'
  | 'city'
  | 'email'
  | 'budget'
  | 'buildType'
  | 'plotOwned'
  | 'campaign'
  | 'plotSize'
  | 'plotSizeUnit'

export interface LeadFieldDefinition {
  key: LeadFieldKey
  label: string
  placeholder?: string | null
  type: 'text' | 'email' | 'number' | 'select' | 'boolean'
  section: 'core' | 'qualification'
  options?: string[]
  required: boolean
  active: boolean
  order: number
}

const DEFAULT_BUILD_TYPES = ['Residential', 'Commercial', 'Villas', 'Apartment', 'Plot']
const DEFAULT_PLOT_UNITS = ['sq ft', 'sq yards', 'acres', 'guntha']

export const DEFAULT_LEAD_FIELD_DEFINITIONS: LeadFieldDefinition[] = [
  {
    key: 'name',
    label: 'Contact Name',
    placeholder: 'Enter contact name',
    type: 'text',
    section: 'core',
    required: true,
    active: true,
    order: 0,
  },
  {
    key: 'phone',
    label: 'Phone Number',
    placeholder: 'Enter phone number',
    type: 'text',
    section: 'core',
    required: true,
    active: true,
    order: 1,
  },
  {
    key: 'city',
    label: 'Location',
    placeholder: 'Select city',
    type: 'select',
    section: 'qualification',
    required: true,
    active: true,
    order: 2,
  },
  {
    key: 'budget',
    label: 'Budget',
    placeholder: 'e.g. 50L - 1Cr',
    type: 'text',
    section: 'qualification',
    required: false,
    active: true,
    order: 3,
  },
  {
    key: 'buildType',
    label: 'Build Type',
    placeholder: 'Select build type',
    type: 'select',
    section: 'qualification',
    options: DEFAULT_BUILD_TYPES,
    required: false,
    active: true,
    order: 4,
  },
  {
    key: 'plotOwned',
    label: 'Plot Owned',
    placeholder: 'Select ownership',
    type: 'boolean',
    section: 'qualification',
    required: false,
    active: true,
    order: 5,
  },
  {
    key: 'campaign',
    label: 'Campaign',
    placeholder: 'Campaign',
    type: 'text',
    section: 'qualification',
    required: false,
    active: true,
    order: 6,
  },
  {
    key: 'email',
    label: 'Email',
    placeholder: 'Enter email address',
    type: 'email',
    section: 'qualification',
    required: false,
    active: true,
    order: 7,
  },
  {
    key: 'plotSize',
    label: 'Plot Size',
    placeholder: 'Size...',
    type: 'number',
    section: 'qualification',
    required: false,
    active: true,
    order: 8,
  },
  {
    key: 'plotSizeUnit',
    label: 'Plot Size Unit',
    placeholder: 'Select unit',
    type: 'select',
    section: 'qualification',
    options: DEFAULT_PLOT_UNITS,
    required: false,
    active: true,
    order: 9,
  },
]

const FIELD_MAP = new Map(DEFAULT_LEAD_FIELD_DEFINITIONS.map((field) => [field.key, field]))

export interface NormalizedLeadFields {
  fields: LeadFieldDefinition[]
  buildTypes: string[]
  plotSizeUnits: string[]
  defaultUnit: string
}

export const normalizeLeadFields = (raw?: any): NormalizedLeadFields => {
  const configuredFields = Array.isArray(raw?.fields) ? raw.fields : []
  const legacyBuildTypes = Array.isArray(raw?.buildTypes) ? raw.buildTypes.filter(Boolean) : []
  const legacyPlotUnits = Array.isArray(raw?.plotSizeUnits) ? raw.plotSizeUnits.filter(Boolean) : []
  const legacyDefaultUnit = typeof raw?.defaultUnit === 'string' ? raw.defaultUnit.trim() : ''

  console.log('[DEBUG] normalizeLeadFields - input fields count:', configuredFields.length)
  console.log('[DEBUG] normalizeLeadFields - sample input:', configuredFields.slice(0, 2).map((f: any) => ({ key: f?.key, label: f?.label, active: f?.active })))

  const mergedFields = DEFAULT_LEAD_FIELD_DEFINITIONS.map((defaultField) => {
    const configuredField = configuredFields.find((field: any) => field?.key === defaultField.key)
    
    // If field was configured, use its values; otherwise use defaults
    const fieldConfig = configuredField || {}
    
    const options =
      defaultField.key === 'buildType'
        ? legacyBuildTypes.length
          ? legacyBuildTypes
          : Array.isArray(fieldConfig.options) && fieldConfig.options.length
            ? fieldConfig.options.filter(Boolean)
            : defaultField.options || []
        : defaultField.key === 'plotSizeUnit'
          ? legacyPlotUnits.length
            ? legacyPlotUnits
            : Array.isArray(fieldConfig.options) && fieldConfig.options.length
              ? fieldConfig.options.filter(Boolean)
              : defaultField.options || []
          : defaultField.options

    // Properly merge: user config takes precedence over defaults
    const merged = {
      key: defaultField.key,
      label: fieldConfig.label ?? defaultField.label,
      placeholder: fieldConfig.placeholder ?? defaultField.placeholder,
      type: fieldConfig.type ?? defaultField.type,
      section: fieldConfig.section ?? defaultField.section,
      options,
      // For name, phone, city - always required and active
      required: ['name', 'phone', 'city'].includes(defaultField.key) 
        ? true 
        : (fieldConfig.required !== undefined ? fieldConfig.required : defaultField.required),
      active: ['name', 'phone', 'city'].includes(defaultField.key)
        ? true
        : (fieldConfig.active !== undefined ? fieldConfig.active : defaultField.active),
      order: fieldConfig.order ?? defaultField.order,
    }

    return merged
  })
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
    .map((field, index) => ({ ...field, order: index }))

  const buildTypes =
    mergedFields.find((field) => field.key === 'buildType')?.options?.filter(Boolean) || DEFAULT_BUILD_TYPES
  const plotSizeUnits =
    mergedFields.find((field) => field.key === 'plotSizeUnit')?.options?.filter(Boolean) || DEFAULT_PLOT_UNITS
  const defaultUnit =
    plotSizeUnits.find((unit: string) => unit === legacyDefaultUnit) || plotSizeUnits[0] || DEFAULT_PLOT_UNITS[0]

  return {
    fields: mergedFields,
    buildTypes,
    plotSizeUnits,
    defaultUnit,
  }
}
