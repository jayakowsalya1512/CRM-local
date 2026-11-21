import { Briefcase } from 'lucide-react'
import type { BuiltinField } from '../constants'

export const tendersMeta = {
  key: 'tenders',
  label: 'Tenders',
  icon: Briefcase,
}

export const tendersFields: Record<string, BuiltinField[]> = {
  basic: [
    { field_key: 'customer_id', default_label: 'Customer Account', field_type: 'select', default_required: true },
    { field_key: 'customer_name', default_label: 'Customer Name', default_required: true },
    { field_key: 'tender_title', default_label: 'Tender Title / Description', default_required: true },
    { field_key: 'portal_ref_number', default_label: 'Portal Tender Ref No.', default_required: true },
    { field_key: 'source_id', default_label: 'Source', field_type: 'select', default_required: true },
    { field_key: 'business_vertical_id', default_label: 'Business Vertical', field_type: 'select' },
    { field_key: 'est_value', default_label: 'Estimated Value', field_type: 'number', default_required: true },
    { field_key: 'tender_status', default_label: 'Tender Status', field_type: 'select' },
    { field_key: 'published_date', default_label: 'Published Date', field_type: 'date', default_required: true },
    { field_key: 'pre_bid_date', default_label: 'Pre-Bid Date', field_type: 'date', default_required: true },
    { field_key: 'submission_date', default_label: 'Submission Deadline', field_type: 'date', default_required: true },
    { field_key: 'assigned_to', default_label: 'Assigned To', field_type: 'select' },
  ],

  workings: [
    { field_key: 'rfp_document', default_label: 'RFP / Tender Document', field_type: 'url', default_required: true, default_col_span: 2 },
    { field_key: 'boq_product', default_label: 'BOQ Product', field_type: 'select' },
    { field_key: 'boq_oem', default_label: 'BOQ OEM', field_type: 'select' },
    { field_key: 'boq_quantity', default_label: 'BOQ Quantity', field_type: 'number' },
    { field_key: 'boq_unit_price', default_label: 'BOQ Unit Price', field_type: 'number' },
    { field_key: 'boq_gst_percent', default_label: 'BOQ GST %', field_type: 'number' },
  ],

  remarks: [
    { field_key: 'notes', default_label: 'Notes', field_type: 'textarea', default_col_span: 2 },
  ],

  details: [
    { field_key: 'split_order', default_label: 'Split Order', field_type: 'checkbox' },
    { field_key: 'reverse_auction', default_label: 'Reverse Auction', field_type: 'checkbox' },
    { field_key: 'tender_fee_required', default_label: 'Tender Fee Required', field_type: 'checkbox' },
    { field_key: 'tender_fee_amount', default_label: 'Tender Fee Amount', field_type: 'number' },
    { field_key: 'tender_fee_method', default_label: 'Tender Fee Payment Method', field_type: 'select' },
    { field_key: 'emd_required', default_label: 'EMD Required', field_type: 'checkbox' },
    { field_key: 'emd_amount', default_label: 'EMD Amount', field_type: 'number' },
    { field_key: 'emd_payment_method', default_label: 'EMD Payment Method', field_type: 'select' },
    { field_key: 'bid_tracking', default_label: 'Bid Tracking / Internal Ref' },
  ],

  final_boq: [
    { field_key: 'final_boq_product', default_label: 'Final BOQ Product', field_type: 'select' },
    { field_key: 'final_boq_oem', default_label: 'Final BOQ OEM', field_type: 'select' },
    { field_key: 'final_boq_authorization', default_label: 'Authorization' },
    { field_key: 'final_boq_quantity', default_label: 'Final BOQ Quantity', field_type: 'number' },
    { field_key: 'final_boq_unit_price', default_label: 'Final BOQ Unit Price', field_type: 'number' },
    { field_key: 'final_boq_gst_percent', default_label: 'Final BOQ GST %', field_type: 'number' },
    { field_key: 'final_boq_total_price', default_label: 'Final BOQ Total Price', field_type: 'number' },
  ],

  workings_documents: [
    { field_key: 'corrigendum_document', default_label: 'Corrigendum Documents', field_type: 'url', default_col_span: 2 },
    { field_key: 'oem_document', default_label: 'OEM Documents', field_type: 'url', default_col_span: 2 },
    { field_key: 'workings_document', default_label: 'Workings Document', field_type: 'url', default_required: true, default_col_span: 2 },
  ],

  technical: [
    { field_key: 'tech_bid_eligible', default_label: 'Tech Bid Eligible', field_type: 'select' },
    { field_key: 'bidder_name', default_label: 'Bidder / Company Name', default_required: true },
    { field_key: 'bidder_type', default_label: 'Bidder Type', field_type: 'select' },
    { field_key: 'bidder_product', default_label: 'Bidder Product', field_type: 'select' },
    { field_key: 'bidder_oem', default_label: 'Bidder OEM', field_type: 'select' },
  ],

  financial: [
    { field_key: 'result', default_label: 'Result', field_type: 'select' },
    { field_key: 'result_date', default_label: 'Result Date', field_type: 'date' },
    { field_key: 'bid_amount', default_label: 'Our Bid Amount', field_type: 'number' },
    { field_key: 'reverse_auction_final_bid', default_label: 'Reverse Auction Final Bid', field_type: 'number' },
  ],

  loss_analysis: [
    { field_key: 'loss_our_position', default_label: 'Our Position', field_type: 'select' },
    { field_key: 'loss_pos1_company', default_label: 'L1 Company' },
    { field_key: 'loss_pos1_amount', default_label: 'L1 Amount', field_type: 'number' },
    { field_key: 'loss_pos2_company', default_label: 'L2 Company' },
    { field_key: 'loss_pos2_amount', default_label: 'L2 Amount', field_type: 'number' },
    { field_key: 'loss_reason', default_label: 'Loss Reason', field_type: 'textarea', default_col_span: 2 },
  ],

  pbg_details: [
    { field_key: 'pbg_required', default_label: 'PBG Required', field_type: 'checkbox' },
    { field_key: 'pbg_amount', default_label: 'PBG Amount', field_type: 'number' },
    { field_key: 'pbg_payment_method', default_label: 'PBG Payment Method', field_type: 'select' },
    { field_key: 'pbg_bg_days', default_label: 'BG Validity Days', field_type: 'number' },
    { field_key: 'pbg_reference', default_label: 'PBG Reference' },
    { field_key: 'pbg_purpose', default_label: 'PBG Purpose' },
  ],

  po_details: [
    { field_key: 'po_num', default_label: 'PO Number', default_required: true },
    { field_key: 'po_date', default_label: 'PO Date', field_type: 'date', default_required: true },
    { field_key: 'po_value', default_label: 'PO Value', field_type: 'number', default_required: true },
    { field_key: 'wrnty_mth', default_label: 'Warranty Months', field_type: 'number' },
    { field_key: 'no_of_consignee', default_label: 'No. of Consignees', field_type: 'number', default_required: true },
    { field_key: 'dlvry_date', default_label: 'Delivery Date', field_type: 'date', default_required: true },
    { field_key: 'completion_days', default_label: 'Completion Days', field_type: 'number' },
    { field_key: 'completion_date', default_label: 'Completion Date', field_type: 'date' },
    { field_key: 'site_eng', default_label: 'Site Engineer' },
    { field_key: 'eng_phone', default_label: 'Engineer Phone', field_type: 'phone' },
    { field_key: 'pmnt_terms', default_label: 'Payment Terms', field_type: 'textarea', default_required: true, default_col_span: 2 },
    { field_key: 'sow', default_label: 'Scope of Work', field_type: 'textarea', default_col_span: 2 },
    { field_key: 'po_doc', default_label: 'PO Document', field_type: 'url', default_required: true, default_col_span: 2 },
  ],

  penalty: [
    { field_key: 'penalty', default_label: 'Penalty / LD Clause', field_type: 'checkbox' },
    { field_key: 'ld_type', default_label: 'LD Type', field_type: 'select' },
    { field_key: 'ld_percent', default_label: 'LD Percentage', field_type: 'number' },
  ],

  consignees: [
    { field_key: 'consignee_name', default_label: 'Consignee Name', default_required: true },
    { field_key: 'consignee_address', default_label: 'Consignee Address', default_col_span: 2 },
    { field_key: 'consignee_city', default_label: 'City' },
    { field_key: 'consignee_state', default_label: 'State' },
    { field_key: 'consignee_pincode', default_label: 'Pincode' },
    { field_key: 'consignee_contact', default_label: 'Contact Person' },
    { field_key: 'consignee_phone', default_label: 'Contact Phone', field_type: 'phone' },
    { field_key: 'delivery_date', default_label: 'Delivery Date', field_type: 'date' },
  ],
}
