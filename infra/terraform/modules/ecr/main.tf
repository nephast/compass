# Image repositories for the two EKS services (COMPASS-7).

resource "aws_ecr_repository" "service" {
  # checkov:skip=CKV_AWS_136:AES256 (SSE-S3-equivalent) rather than a CMK: images contain no secrets, and a CMK bills per pull.
  for_each = toset(var.services)

  name = "compass-${each.value}"

  # Immutable: a tag, once pushed, always means the same bytes. CI tags with
  # the git SHA, and promotion to prod (COMPASS-27) re-deploys that exact tag
  # -- which is only a guarantee if nobody can push over it.
  image_tag_mutability = "IMMUTABLE"

  image_scanning_configuration {
    scan_on_push = true
  }

  encryption_configuration {
    encryption_type = "AES256"
  }

  # Teardown must succeed in one pass even with images present.
  force_delete = true
}

resource "aws_ecr_lifecycle_policy" "service" {
  for_each   = aws_ecr_repository.service
  repository = each.value.name

  # Storage is $0.10/GB-month. Untagged layers (from failed or superseded
  # pushes) go after a day; tagged images keep the newest 15 -- enough to roll
  # back through two weeks of merges.
  policy = jsonencode({
    rules = [
      {
        rulePriority = 1
        description  = "Expire untagged images after 1 day"
        selection = {
          tagStatus   = "untagged"
          countType   = "sinceImagePushed"
          countUnit   = "days"
          countNumber = 1
        }
        action = { type = "expire" }
      },
      {
        rulePriority = 2
        description  = "Keep the 15 most recent tagged images"
        selection = {
          tagStatus   = "any"
          countType   = "imageCountMoreThan"
          countNumber = 15
        }
        action = { type = "expire" }
      },
    ]
  })
}
