provider "aws" {
  region = var.region

  # Environment is "account" rather than dev/prod: these resources outlive any
  # single environment. The cost report (COMPASS-37) groups on these tags, so
  # account-lifetime spend stays distinguishable from environment spend.
  default_tags {
    tags = {
      Project     = "compass"
      Environment = "account"
      ManagedBy   = "terraform"
    }
  }
}
