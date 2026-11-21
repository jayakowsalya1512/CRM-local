SET FOREIGN_KEY_CHECKS=0;
DROP TABLE IF EXISTS `lead_sources`;
CREATE TABLE `lead_sources` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `name` varchar(100) NOT NULL,
  `description` text DEFAULT NULL,
  `is_active` tinyint(1) DEFAULT NULL,
  `created_at` datetime DEFAULT current_timestamp(),
  PRIMARY KEY (`id`),
  UNIQUE KEY `name` (`name`)
) ENGINE=InnoDB AUTO_INCREMENT=7 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
INSERT INTO `lead_sources` (`id`, `name`, `description`, `is_active`, `created_at`) VALUES (1, 'GEM Portal', NULL, 1, '2026-10-29 16:53:46');
INSERT INTO `lead_sources` (`id`, `name`, `description`, `is_active`, `created_at`) VALUES (2, 'E-Procurement', NULL, 1, '2026-10-29 16:53:46');
INSERT INTO `lead_sources` (`id`, `name`, `description`, `is_active`, `created_at`) VALUES (3, 'Direct Enquiry', NULL, 1, '2026-10-29 16:53:46');
INSERT INTO `lead_sources` (`id`, `name`, `description`, `is_active`, `created_at`) VALUES (4, 'OEM Reference', NULL, 1, '2026-10-29 16:53:46');
INSERT INTO `lead_sources` (`id`, `name`, `description`, `is_active`, `created_at`) VALUES (5, 'Website', NULL, 1, '2026-10-29 16:53:46');
INSERT INTO `lead_sources` (`id`, `name`, `description`, `is_active`, `created_at`) VALUES (6, 'Referral', NULL, 1, '2026-10-29 16:53:46');
SET FOREIGN_KEY_CHECKS=1;
