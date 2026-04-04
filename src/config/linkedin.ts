export const linkedinConfig = {
  clientId: process.env.LINKEDIN_CLIENT_ID!,
  clientSecret: process.env.LINKEDIN_CLIENT_SECRET!,
  redirectUri: process.env.LINKEDIN_REDIRECT_URI || `${process.env.APP_BASE_URL}/integrations/linkedin/callback`,
  
  get authUrl(): string {
    const scopes = [
      'r_emailaddress',
      'r_liteprofile',
      'rw_ads',
      'r_ads_leadgen'
    ].join(' ')
    
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: this.clientId,
      redirect_uri: this.redirectUri,
      scope: scopes,
      state: Math.random().toString(36).substring(7)
    })
    
    return `https://www.linkedin.com/oauth/v2/authorization?${params.toString()}`
  },
  
  get tokenUrl(): string {
    return 'https://www.linkedin.com/oauth/v2/accessToken'
  },
  
  get userInfoUrl(): string {
    return 'https://api.linkedin.com/v2/people/~:(id,firstName,lastName,emailAddress)'
  },
  
  get apiBaseUrl(): string {
    return 'https://api.linkedin.com/v2'
  }
}
