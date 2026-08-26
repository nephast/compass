provider "aws" {
  region = var.region

  # Applied to every taggable resource created by this config. The cost report
  # (COMPASS-37) groups on these, so they are not optional decoration.
  default_tags {
    tags = {
      Project     = "compass"
      Environment = var.env
      ManagedBy   = "terraform"
    }
  }
}
