export const googleAdsConfig = {
  clientId: process.env.GOOGLE_ADS_CLIENT_ID!,
  clientSecret: process.env.GOOGLE_ADS_CLIENT_SECRET!,
  redirectUri: process.env.GOOGLE_ADS_REDIRECT_URI || `${process.env.APP_BASE_URL}/integrations/google-ads/callback`,
  developerToken: process.env.GOOGLE_ADS_DEVELOPER_TOKEN!,
  loginCustomerId: process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID!,
  
  get authUrl(): string {
    const scopes = [
      'https://www.googleapis.com/auth/adwords',
      'https://www.googleapis.com/auth/userinfo.email',
      'https://www.googleapis.com/auth/userinfo.profile'
    ].join(' ')
    
    const params = new URLSearchParams({
      client_id: this.clientId,
      redirect_uri: this.redirectUri,
      scope: scopes,
      response_type: 'code',
      access_type: 'offline',
      prompt: 'consent'
    })
    
    return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`
  },
  
  get tokenUrl(): string {
    return 'https://oauth2.googleapis.com/token'
  },
  
  get userInfoUrl(): string {
    return 'https://www.googleapis.com/oauth2/v2/userinfo'
  }
}
